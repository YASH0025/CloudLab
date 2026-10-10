import { EngineError } from "../errors";

/**
 * IAM policy documents: parsing with the real service's validation errors, and
 * evaluation with the real rules. An explicit Deny always wins; otherwise any
 * Allow grants access; otherwise access is implicitly denied.
 *
 * Supported: Effect, Action/NotAction, Resource/NotResource, wildcards (* and ?).
 * Conditions aren't simulated: a statement with a Condition never matches, and
 * the explanation says so.
 */

export interface Statement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action?: string[];
  NotAction?: string[];
  Resource?: string[];
  NotResource?: string[];
  Principal?: unknown;
  Condition?: unknown;
}

export interface PolicyDocument {
  Version?: string;
  Statement: Statement[];
}

const malformed = (message: string) => new EngineError("MalformedPolicyDocument", message);

const asList = (v: unknown): string[] | undefined =>
  v === undefined ? undefined : (Array.isArray(v) ? v : [v]).map((x) => String(x));

/**
 * Parses and validates a policy document. `kind` is "identity" for policies
 * attached to users, groups and roles (no Principal allowed) and "trust" for a
 * role's assume-role policy (Principal required).
 */
export function parsePolicy(text: string | object, kind: "identity" | "trust" = "identity"): PolicyDocument {
  let raw: unknown;
  if (typeof text === "string") {
    try {
      raw = JSON.parse(text);
    } catch {
      throw malformed("The policy failed legacy parsing");
    }
  } else raw = text;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw malformed("The policy failed legacy parsing");
  const doc = raw as Record<string, unknown>;
  if (doc.Version !== undefined && doc.Version !== "2012-10-17" && doc.Version !== "2008-10-17") {
    throw malformed("The policy must contain a valid version string");
  }
  if (doc.Statement === undefined) throw malformed("Syntax errors in policy.");
  const statements = (Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement]) as Record<string, unknown>[];
  if (statements.length === 0) throw malformed("Syntax errors in policy.");

  return {
    Version: doc.Version as string | undefined,
    Statement: statements.map((st) => {
      if (!st || typeof st !== "object") throw malformed("Syntax errors in policy.");
      if (st.Effect !== "Allow" && st.Effect !== "Deny") throw malformed("Syntax errors in policy.");
      const Action = asList(st.Action);
      const NotAction = asList(st.NotAction);
      if (!Action && !NotAction) throw malformed("Policy statement must contain actions.");
      for (const a of [...(Action ?? []), ...(NotAction ?? [])]) {
        if (a !== "*" && !/^[a-z0-9-]+:[A-Za-z0-9*?]+$/.test(a)) {
          throw malformed("Actions/Conditions must be prefaced by a vendor, e.g., iam, sdb, ec2, etc.");
        }
      }
      const Resource = asList(st.Resource);
      const NotResource = asList(st.NotResource);
      if (kind === "identity") {
        if (st.Principal !== undefined || st.NotPrincipal !== undefined) throw malformed("Policy document should not specify a principal.");
        if (!Resource && !NotResource) throw malformed("Policy statement must contain resources.");
      } else {
        if (st.Principal === undefined) throw malformed("Has prohibited field Resource");
        if (Resource || NotResource) throw malformed("Has prohibited field Resource");
      }
      return {
        ...(st.Sid !== undefined ? { Sid: String(st.Sid) } : {}),
        Effect: st.Effect,
        ...(Action ? { Action } : {}),
        ...(NotAction ? { NotAction } : {}),
        ...(Resource ? { Resource } : {}),
        ...(NotResource ? { NotResource } : {}),
        ...(st.Principal !== undefined ? { Principal: st.Principal } : {}),
        ...(st.Condition !== undefined ? { Condition: st.Condition } : {}),
      } as Statement;
    }),
  };
}

/** IAM wildcard match: * is any run of characters, ? is one character. */
export function wildcard(pattern: string, value: string, ignoreCase = false): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, ignoreCase ? "i" : "");
  return re.test(value);
}

const actionMatches = (patterns: string[], action: string) => patterns.some((p) => wildcard(p, action, true));
const resourceMatches = (patterns: string[], resource: string) => patterns.some((p) => p === "*" || wildcard(p, resource));

/** A policy as seen by the evaluator: where it came from and what it says. */
export interface AttachedPolicy {
  /** e.g. "AmazonS3ReadOnlyAccess" */
  name: string;
  arn: string;
  /** e.g. "attached to group developers" */
  via: string;
  document: PolicyDocument;
}

export interface MatchedStatement {
  policy: string;
  arn: string;
  via: string;
  sid?: string;
  index: number;
  effect: "Allow" | "Deny";
}

export type Decision = "allowed" | "explicitDeny" | "implicitDeny";

export interface Evaluation {
  decision: Decision;
  action: string;
  resource: string;
  /** The statements that decided it: the Deny, or the Allows. */
  matched: MatchedStatement[];
  /** Statements skipped because their Condition can't be simulated. */
  skippedConditions: MatchedStatement[];
}

/** Evaluates identity-based policies for one action on one resource. */
export function evaluate(policies: AttachedPolicy[], action: string, resource: string): Evaluation {
  const allows: MatchedStatement[] = [];
  const denies: MatchedStatement[] = [];
  const skipped: MatchedStatement[] = [];
  for (const p of policies) {
    p.document.Statement.forEach((st, index) => {
      const actionOk = st.Action ? actionMatches(st.Action, action) : !actionMatches(st.NotAction!, action);
      const resourceOk = st.Resource ? resourceMatches(st.Resource, resource) : !resourceMatches(st.NotResource ?? [], resource);
      if (!actionOk || !resourceOk) return;
      const m: MatchedStatement = { policy: p.name, arn: p.arn, via: p.via, sid: st.Sid, index, effect: st.Effect };
      if (st.Condition !== undefined) skipped.push(m);
      else (st.Effect === "Deny" ? denies : allows).push(m);
    });
  }
  const decision: Decision = denies.length ? "explicitDeny" : allows.length ? "allowed" : "implicitDeny";
  return { decision, action, resource, matched: denies.length ? denies : allows, skippedConditions: skipped };
}
