import type { NextRequest } from "next/server";
import { getAccountId, getEngine, handle } from "@/server/api";

/** Lists a bucket's objects and "folders" under a prefix, like ListObjectsV2 with a "/" delimiter. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/buckets/[bucket]/objects">) {
  return handle(async () => {
    const { bucket } = await ctx.params;
    const prefix = request.nextUrl.searchParams.get("prefix") ?? "";
    const accountId = await getAccountId();
    const result = await getEngine().objects.list(accountId, bucket, { prefix, delimiter: "/" });
    return Response.json(result);
  });
}

/** Deletes everything under a prefix (a "folder"). */
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/buckets/[bucket]/objects">) {
  return handle(async () => {
    const { bucket } = await ctx.params;
    const prefix = request.nextUrl.searchParams.get("prefix") ?? "";
    const accountId = await getAccountId();
    const deleted = await getEngine().objects.deleteAll(accountId, bucket, prefix);
    return Response.json({ deleted });
  });
}
