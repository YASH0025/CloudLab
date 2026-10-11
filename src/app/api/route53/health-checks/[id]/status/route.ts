import { healthCheckStatus } from "@/engine/route53/dns";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

/** A health check's current result, as get-health-check-status reports it. */
export async function GET(_req: Request, ctx: RouteContext<"/api/route53/health-checks/[id]/status">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const caller = await getCaller();
    authorizeActions(caller, [{ action: "route53:GetHealthCheckStatus", resource: `arn:aws:route53:::healthcheck/${id}` }]);
    const engine = getEngine();
    const hc = await engine.getTyped(caller.accountId, id, "route53", "health-check");
    const status = await healthCheckStatus(engine, caller.accountId, hc);
    return Response.json({ ...status, checkedAt: engine.now().toISOString() });
  });
}
