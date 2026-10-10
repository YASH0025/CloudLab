import type { NextRequest } from "next/server";
import { EngineError } from "@/engine/errors";
import { LIMITS } from "@/engine/objects";
import { getAccountId, getEngine, handle } from "@/server/api";

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
    const { info, data } = await getEngine().objects.get(await getAccountId(), bucket, key);
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
    const object = await getEngine().objects.put(await getAccountId(), bucket, key, data, type || undefined);
    return Response.json({ object });
  });
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/buckets/[bucket]/object">) {
  return handle(async () => {
    const { bucket } = await ctx.params;
    await getEngine().objects.delete(await getAccountId(), bucket, keyOf(request));
    return Response.json({ deleted: true });
  });
}
