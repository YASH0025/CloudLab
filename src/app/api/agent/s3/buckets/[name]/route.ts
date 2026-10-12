import type { NextRequest } from "next/server";
import { EngineError } from "@/engine/errors";
import { LOCAL_REGION } from "@/engine/catalog";
import { getEngine, getLocal, handle } from "@/server/api";

/** DeleteBucket through the AWS endpoint on the learner's computer (the agent has checked it's empty). */
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/agent/s3/buckets/[name]">) {
  return handle(async () => {
    const agent = await getLocal().authenticate(request.headers.get("authorization"));
    const { name } = await ctx.params;
    const engine = getEngine();
    const bucket = await engine.getTyped(agent.accountId, name, "storage", "bucket");
    if (bucket.region !== LOCAL_REGION) throw new EngineError("NoSuchBucket", "The specified bucket does not exist", 404);
    // The agent checked the folder is empty just now; CloudLab's count may lag behind it.
    await engine.setAttributes(agent.accountId, bucket.id, { objectCount: 0, totalBytes: 0 });
    await engine.remove(agent.accountId, bucket.id);
    return new Response(null, { status: 204 });
  });
}
