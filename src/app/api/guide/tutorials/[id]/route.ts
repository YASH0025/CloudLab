import type { NextRequest } from "next/server";
import { DEFAULT_REGION, EngineError, isRegion } from "@/engine";
import { viewTutorial } from "@/guide/tutorials";
import { getAccountId, getEngine, handle, IDENTITY_HEADER } from "@/server/api";

/** One tutorial, with each step checked against the caller's resources in a region. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/guide/tutorials/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const requested = request.nextUrl.searchParams.get("region") ?? DEFAULT_REGION;
    const region = isRegion(requested) ? requested : DEFAULT_REGION;
    const accountId = await getAccountId();
    await getEngine().ensureDefaults(accountId, region);
    // Steps like "act as dev" look at the identity the console is using.
    const identity = request.headers.get(IDENTITY_HEADER) ?? "root";
    const tutorial = await viewTutorial(getEngine(), accountId, region, id, identity);
    if (!tutorial) throw new EngineError("TutorialNotFound", `There is no tutorial '${id}'.`, 404);
    return Response.json({ tutorial });
  });
}
