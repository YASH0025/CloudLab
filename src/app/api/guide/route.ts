import type { NextRequest } from "next/server";
import { DEFAULT_REGION, isRegion } from "@/engine";
import { advise } from "@/guide/advisor";
import { getAccountId, getEngine, handle } from "@/server/api";

/** "What's next?": the most useful next step for the caller's setup in a region. */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const requested = request.nextUrl.searchParams.get("region") ?? DEFAULT_REGION;
    const region = isRegion(requested) ? requested : DEFAULT_REGION;
    const accountId = await getAccountId();
    await getEngine().ensureDefaults(accountId, region);
    return Response.json({ advice: await advise(getEngine(), accountId, region) });
  });
}
