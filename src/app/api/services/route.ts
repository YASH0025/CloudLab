import type { NextRequest } from "next/server";
import { DEFAULT_REGION, REGIONS, isRegion, resolveServices } from "@/engine";
import { handle } from "@/server/api";

/** Service catalog with region-specific options, used to render console forms. */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const requested = request.nextUrl.searchParams.get("region") ?? DEFAULT_REGION;
    const region = isRegion(requested) ? requested : DEFAULT_REGION;
    return Response.json({ region, regions: REGIONS, services: resolveServices(region) });
  });
}
