import { z } from "zod";
import { EngineError } from "@/engine/errors";
import { check, rolePrincipal, resolvePrincipal, type Principal } from "@/engine/iam/authorize";
import { policyByArn } from "@/engine/services/iam";
import { getAccountId, getEngine, handle } from "@/server/api";

const body = z.object({
  kind: z.enum(["user", "group", "role"]),
  name: z.string().min(1).max(128),
  action: z.string().trim().regex(/^([a-z0-9-]+:[A-Za-z0-9*?]+|\*)$/, "Enter an action like s3:GetObject."),
  resource: z.string().trim().min(1).max(2048).default("*"),
});

/**
 * The console's permission checker (IAM's policy simulator): would this user,
 * group or role be allowed to perform an action on a resource, and why?
 */
export async function POST(request: Request) {
  return handle(async () => {
    const input = body.parse(await request.json());
    const accountId = await getAccountId();
    const engine = getEngine();
    const list = (service: string, type: string) => engine.list(accountId, { service, type, region: "global" });
    let principal: Principal;
    if (input.kind === "user") {
      principal = await resolvePrincipal(engine, accountId, { kind: "user", name: input.name });
    } else {
      const r = (await list("iam", input.kind)).find((x) => x.name === input.name);
      if (!r) throw new EngineError("NoSuchEntity", `The ${input.kind} with name ${input.name} cannot be found.`, 404);
      if (input.kind === "role") principal = await rolePrincipal(engine, accountId, r);
      else {
        const policies = [];
        for (const arn of (r.config.policyArns as string[]) ?? []) {
          const p = await policyByArn(arn, accountId, list);
          if (p) policies.push({ name: p.name, arn, via: "attached to the group", document: p.document });
        }
        principal = { identity: { kind: "user", name: r.name }, arn: String(r.attributes.arn), policies };
      }
    }
    const result = check(principal, input.action, input.resource);
    return Response.json({ result, policies: principal.policies.map(({ name, arn, via }) => ({ name, arn, via })) });
  });
}
