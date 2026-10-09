import type { NextRequest } from "next/server";
import { analyzeReachability, reachabilityInput } from "@/engine/analysis/reachability";
import { getAccountId, getEngine, handle } from "@/server/api";

/** Checks whether traffic from a source can reach an instance, and explains why or why not. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/reachability">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const input = reachabilityInput.parse(await request.json());
    const accountId = await getAccountId();
    const result = await analyzeReachability(getEngine(), accountId, id, input);
    return Response.json({ result });
  });
}
