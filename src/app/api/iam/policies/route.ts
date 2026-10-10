import { MANAGED_POLICIES } from "@/engine/iam/managed";
import { getAccountId, getEngine, handle } from "@/server/api";

/**
 * Policies that can be attached: AWS managed ones and the account's own. Used by
 * the console's policy picker, so it isn't limited by the identity being acted as.
 */
export async function GET() {
  return handle(async () => {
    const accountId = await getAccountId();
    const own = await getEngine().list(accountId, { service: "iam", type: "policy", region: "global" });
    return Response.json({
      policies: [
        ...own.map((p) => ({ name: p.name, arn: String(p.attributes.arn), description: String(p.config.description ?? ""), managed: false })),
        ...MANAGED_POLICIES.map((p) => ({ name: p.name, arn: p.arn, description: p.description, managed: true })),
      ],
    });
  });
}
