import type { NextRequest } from "next/server";
import { analyzeReachability, reachabilityInput } from "@/engine/analysis/reachability";
import { authorizeConsole, getCaller, getEngine, handle } from "@/server/api";

/** Checks whether traffic from a source can reach an instance, and explains why or why not. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/reachability">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const input = reachabilityInput.parse(await request.json());
    const caller = await getCaller();
    const instance = await getEngine().get(caller.accountId, id);
    // Reachability Analyzer reads the network configuration: a Describe permission.
    authorizeConsole(caller, { kind: "read" }, instance, instance, instance.region);
    const result = await analyzeReachability(getEngine(), caller.accountId, id, input);
    return Response.json({ result });
  });
}
