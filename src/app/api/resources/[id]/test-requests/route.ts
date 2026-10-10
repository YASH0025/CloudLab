import type { NextRequest } from "next/server";
import { z } from "zod";
import { testLoadBalancer } from "@/engine/analysis/loadtest";
import { EngineError } from "@/engine/errors";
import { authorizeConsole, getCaller, getEngine, handle } from "@/server/api";

const body = z.object({
  port: z.coerce.number().int().min(1).max(65535).optional(),
  count: z.coerce.number().int().min(1).max(20).default(6),
});

/** CloudLab's stand-in for opening the load balancer's address: simulated requests, with a diagnosis. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/test-requests">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const input = body.parse(await request.json().catch(() => ({})));
    const caller = await getCaller();
    const engine = getEngine();
    const lb = await engine.get(caller.accountId, id);
    if (lb.type !== "load-balancer") throw new EngineError("ValidationError", "Requests can only be sent to a load balancer.");
    // Reading the setup is a Describe; the requests themselves are anonymous internet traffic.
    authorizeConsole(caller, { kind: "read" }, lb, lb, lb.region);
    await engine.ensureDefaults(caller.accountId, lb.region);
    const result = await testLoadBalancer(engine, caller.accountId, await engine.get(caller.accountId, id), input);
    return Response.json({ result });
  });
}
