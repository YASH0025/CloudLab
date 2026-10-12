import type { NextRequest } from "next/server";
import { EngineError } from "@/engine/errors";
import { LIMITS } from "@/engine/objects";
import { s3ObjectArn } from "@/engine/iam/arns";
import { authorizeActions, getCaller, getEngine, handle, type Caller } from "@/server/api";

/** Checks an object-level S3 action and returns the account to use. */
async function allowed(action: string, bucket: string, key: string): Promise<Caller> {
  const caller = await getCaller();
  authorizeActions(caller, [{ action, resource: s3ObjectArn(bucket, key) }]);
  return caller;
}

/**
 * One object, addressed by ?key=. GET downloads it, PUT uploads the request
 * body (its Content-Type is kept), DELETE removes it.
 */

function keyOf(request: NextRequest): string {
  const key = request.nextUrl.searchParams.get("key");
  if (!key) throw new EngineError("InvalidArgument", "Object key must not be empty.");
  return key;
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/buckets/[bucket]/object">) {
  return handle(async () => {
    const { bucket } = await ctx.params;
    const key = keyOf(request);
    const { accountId } = await allowed("s3:GetObject", bucket, key);
    const { info, data } = await getEngine().objects.get(accountId, bucket, key);
    const filename = key.split("/").filter(Boolean).pop() ?? "download";
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": info.contentType,
        "Content-Length": String(info.size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "X-Content-Type-Options": "nosniff",
        ETag: `"${info.etag}"`,
      },
    });
  });
}

export async function PUT(request: NextRequest, ctx: RouteContext<"/api/buckets/[bucket]/object">) {
  return handle(async () => {
    const { bucket } = await ctx.params;
    const key = keyOf(request);
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > LIMITS.objectBytes) {
      throw new EngineError("EntityTooLarge", "Your proposed upload exceeds the maximum allowed size (CloudLab allows 1 MB per object).");
    }
    const data = Buffer.from(await request.arrayBuffer());
    const type = request.headers.get("content-type") ?? undefined;
    const { accountId } = await allowed("s3:PutObject", bucket, key);
    const object = await getEngine().objects.put(accountId, bucket, key, data, type || undefined);
    return Response.json({ object });
  });
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/buckets/[bucket]/object">) {
  return handle(async () => {
    const { bucket } = await ctx.params;
    const key = keyOf(request);
    const { accountId } = await allowed("s3:DeleteObject", bucket, key);
    await getEngine().objects.delete(accountId, bucket, key);
    return Response.json({ deleted: true });
  });
}
