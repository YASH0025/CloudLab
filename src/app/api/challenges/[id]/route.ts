import type { NextRequest } from "next/server";
import { EngineError } from "@/engine/errors";
import { startChallenge, viewChallenge } from "@/guide/challenges";
import { challengeAccountId, getEngine, getLabAccountId, handle } from "@/server/api";

/**
 * A challenge always runs in the learner's challenge account, never in their lab,
 * whichever workspace the console is in.
 */
async function account() {
  return challengeAccountId(await getLabAccountId());
}

/** The challenge's story, the hints asked for (?hints=0..3) and whether it's fixed yet. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/challenges/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const hints = Number(request.nextUrl.searchParams.get("hints") ?? 0) || 0;
    const view = await viewChallenge(getEngine(), await account(), id, hints);
    if (!view) throw new EngineError("NotFound", `No challenge called ${id}.`, 404);
    return Response.json({ challenge: view });
  });
}

/** Starts (or restarts) a challenge: wipes the challenge account and builds the broken setup. */
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/challenges/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const engine = getEngine();
    const accountId = await account();
    if (!(await startChallenge(engine, accountId, id))) throw new EngineError("NotFound", `No challenge called ${id}.`, 404);
    return Response.json({ challenge: await viewChallenge(engine, accountId, id, 0) });
  });
}
