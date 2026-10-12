import type { NextRequest } from "next/server";
import { explore, exploreAction } from "@/engine/dynamodb/explore";
import { parseExplore } from "@/engine/dynamodb/explore-input";
import { EngineError } from "@/engine/errors";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

/**
 * The table page's "Explore items" (engine/dynamodb/explore.ts). Tables on
 * My computer (local) are explored through the agent on that computer instead.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/items">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const input = parseExplore(await request.json().catch(() => ({})));
    const caller = await getCaller();
    const engine = getEngine();
    const t = await engine.get(caller.accountId, id);
    if (t.service !== "dynamodb" || t.type !== "table") throw new EngineError("ValidationError", "Only DynamoDB tables have items.");
    authorizeActions(caller, [exploreAction(t, input)]);
    return Response.json(await explore(engine, t, input));
  });
}
