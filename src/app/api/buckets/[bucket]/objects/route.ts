import type { NextRequest } from "next/server";
import { s3BucketArn, s3ObjectArn } from "@/engine/iam/arns";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

/** Lists a bucket's objects and "folders" under a prefix, like ListObjectsV2 with a "/" delimiter. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/buckets/[bucket]/objects">) {
  return handle(async () => {
    const { bucket } = await ctx.params;
    const prefix = request.nextUrl.searchParams.get("prefix") ?? "";
    const caller = await getCaller();
    authorizeActions(caller, [{ action: "s3:ListBucket", resource: s3BucketArn({ id: bucket, name: bucket, region: "", config: {} }) }]);
    const result = await getEngine().objects.list(caller.accountId, bucket, { prefix, delimiter: "/" });
    return Response.json(result);
  });
}

/** Deletes everything under a prefix (a "folder"). */
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/buckets/[bucket]/objects">) {
  return handle(async () => {
    const { bucket } = await ctx.params;
    const prefix = request.nextUrl.searchParams.get("prefix") ?? "";
    const caller = await getCaller();
    authorizeActions(caller, [{ action: "s3:DeleteObject", resource: s3ObjectArn(bucket, `${prefix}*`) }]);
    const deleted = await getEngine().objects.deleteAll(caller.accountId, bucket, prefix);
    return Response.json({ deleted });
  });
}
