import type { NextRequest } from "next/server";
import { targetHealth } from "@/engine/analysis/health";
import { EngineError } from "@/engine/errors";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

/** A target group's targets and their health, as DescribeTargetHealth reports it. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/resources/[id]/health">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const caller = await getCaller();
    const engine = getEngine();
    const tg = await engine.get(caller.accountId, id);
    if (tg.type !== "target-group") throw new EngineError("ValidationError", "Target health is only available for target groups.");
    authorizeActions(caller, [{ action: "elasticloadbalancing:DescribeTargetHealth", resource: tg.id }]);
    await engine.ensureDefaults(caller.accountId, tg.region);
    return Response.json({ targets: await targetHealth(engine, caller.accountId, await engine.get(caller.accountId, id), engine.now()) });
  });
}
