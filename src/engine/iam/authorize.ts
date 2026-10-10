import type { Engine } from "../engine";
import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import { getTypeDef } from "../registry";
import { policyByArn, trustedPrincipals } from "../services/iam";
import type { Resource } from "../types";
import { evaluate, type AttachedPolicy, type Evaluation } from "./policy";

/**
 * Who is making a request, and whether they may. The learner's account starts
 * as the root user, who may do anything. Switching to an IAM user or role makes
 * every request go through IAM's policy evaluation, with the real errors.
 */

export type Identity = { kind: "root" } | { kind: "user"; name: string } | { kind: "role"; name: string };

export const ROOT: Identity = { kind: "root" };

/** Parses "root", "user/dev" or "role/admin" (the console sends this with every request). */
export function parseIdentity(text: string | null | undefined): Identity {
  const m = /^(user|role)\/([\w+=,.@-]{1,128})$/.exec(text ?? "");
  return m ? { kind: m[1] as "user" | "role", name: m[2] } : ROOT;
}

export interface Principal {
  identity: Identity;
  arn: string;
  /** The policies that apply, with where each came from. Empty for root. */
  policies: AttachedPolicy[];
}

const iamList = (engine: Engine, accountId: string) => (service: string, type: string) =>
  engine.list(accountId, { service, type, region: "global" });

async function policiesOf(engine: Engine, accountId: string, arns: string[], via: string): Promise<AttachedPolicy[]> {
  const out: AttachedPolicy[] = [];
  for (const arn of arns) {
    const p = await policyByArn(arn, accountId, iamList(engine, accountId));
    if (p) out.push({ name: p.name, arn, via, document: p.document });
  }
  return out;
}

/** Resolves an identity to its ARN and policies, failing like AWS for unknown users or untrusted roles. */
export async function resolvePrincipal(engine: Engine, accountId: string, identity: Identity): Promise<Principal> {
  const account = accountNumber(accountId);
  if (identity.kind === "root") return { identity, arn: `arn:aws:iam::${account}:root`, policies: [] };

  const list = iamList(engine, accountId);
  if (identity.kind === "user") {
    const user = (await list("iam", "user")).find((u) => u.name === identity.name);
    if (!user) {
      throw new EngineError("InvalidClientTokenId", "The security token included in the request is invalid.", 403);
    }
    const policies = await policiesOf(engine, accountId, (user.config.policyArns as string[]) ?? [], "attached directly");
    for (const name of (user.config.groups as string[]) ?? []) {
      const g = (await list("iam", "group")).find((x) => x.name === name);
      if (g) policies.push(...(await policiesOf(engine, accountId, (g.config.policyArns as string[]) ?? [], `from group ${name}`)));
    }
    return { identity, arn: user.attributes.arn as string, policies };
  }

  const role = (await list("iam", "role")).find((r) => r.name === identity.name);
  const roleArn = `arn:aws:iam::${account}:role/${identity.name}`;
  // Switching to a role is an sts:AssumeRole call made by the account: its trust policy must allow that.
  const trusted = role ? trustedPrincipals(String(role.config.trustPolicy)).aws : [];
  const accountOk = trusted.some((p) => p === "*" || p === account || p === `arn:aws:iam::${account}:root`);
  if (!role || !accountOk) {
    throw new EngineError(
      "AccessDenied",
      `User: arn:aws:iam::${account}:root is not authorized to perform: sts:AssumeRole on resource: ${roleArn}`,
      403,
      { hint: role ? "The role's trust policy doesn't let this account assume it." : "The role doesn't exist." },
    );
  }
  return {
    identity,
    arn: `arn:aws:sts::${account}:assumed-role/${identity.name}/cloudlab-session`,
    policies: await policiesOf(engine, accountId, (role.config.policyArns as string[]) ?? [], "attached to the role"),
  };
}

/** A role as a principal, without the assume-role check (for the policy simulator). */
export async function rolePrincipal(engine: Engine, accountId: string, role: Resource): Promise<Principal> {
  return {
    identity: { kind: "role", name: role.name },
    arn: String(role.attributes.arn),
    policies: await policiesOf(engine, accountId, (role.config.policyArns as string[]) ?? [], "attached to the role"),
  };
}

/** Evaluates one action on one resource. Root is always allowed. */
export function check(principal: Principal, action: string, resource: string): Evaluation {
  if (principal.identity.kind === "root") {
    return { decision: "allowed", action, resource, matched: [], skippedConditions: [] };
  }
  return evaluate(principal.policies, action, resource);
}

/** The error AWS returns for a denied request: EC2 says UnauthorizedOperation, the rest AccessDenied. */
export function denialError(principal: Principal, e: Evaluation): EngineError {
  const because =
    e.decision === "explicitDeny"
      ? "with an explicit deny in an identity-based policy"
      : `because no identity-based policy allows the ${e.action} action`;
  const service = e.action.split(":")[0];
  if (service === "ec2") {
    return new EngineError(
      "UnauthorizedOperation",
      `You are not authorized to perform this operation. User: ${principal.arn} is not authorized to perform: ${e.action} on resource: ${e.resource} ${because}`,
      403,
      { evaluation: e },
    );
  }
  const resource = service === "s3" ? `"${e.resource}"` : e.resource;
  return new EngineError("AccessDenied", `User: ${principal.arn} is not authorized to perform: ${e.action} on resource: ${resource} ${because}`, 403, {
    evaluation: e,
  });
}

/** Throws AWS's error unless the principal may perform every action listed. */
export function authorize(principal: Principal, checks: { action: string; resource: string }[]): void {
  for (const c of checks) {
    const e = check(principal, c.action, c.resource);
    if (e.decision !== "allowed") throw denialError(principal, e);
  }
}

// ---------- the console's generic operations ----------

/** IAM checks for a console operation on a resource type. */
export function consoleChecks(
  op: { kind: "create" | "read" | "update" | "delete" | "action"; action?: string; changed?: string[] },
  def: { service: string; type: string },
  accountId: string,
  target: Pick<Resource, "id" | "name" | "region" | "config"> | null,
  region: string,
): { action: string; resource: string }[] {
  const t = getTypeDef(def.service, def.type);
  if (!t.iam) return [];
  const account = accountNumber(accountId);
  const arn = target ? t.iam.arn(target, account) : t.iam.arn({ id: "*", name: "*", region, config: {} }, account);
  // EC2 creates and lists aren't about one existing resource; everything else is checked on its own ARN.
  const resource = !target || (arn.startsWith("arn:aws:ec2:") && (op.kind === "create" || op.kind === "read")) ? anyOf(arn) : arn;
  const actions =
    op.kind === "create"
      ? [t.iam.create]
      : op.kind === "read"
        ? [t.iam.read]
        : op.kind === "delete"
          ? [t.iam.delete]
          : op.kind === "action"
            ? [t.iam.actions?.[op.action ?? ""] ?? t.iam.update ?? t.iam.read].flat().filter((a): a is string => typeof a === "string")
            : typeof t.iam.update === "function"
              ? t.iam.update(op.changed ?? [])
              : t.iam.update
                ? [t.iam.update]
                : [];
  return actions.map((action) => ({ action, resource }));
}

/** "Any resource of this kind": …:instance/*, …:user/*, arn:aws:s3:::* */
function anyOf(arn: string): string {
  return arn.replace(/[^/:]*$/, "*");
}
