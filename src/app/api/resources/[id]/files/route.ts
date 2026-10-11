import { z } from "zod";
import { writeVolumeFile } from "@/engine/services/ebs";
import { getCaller, getEngine, handle } from "@/server/api";

const body = z.object({ path: z.string().min(1).max(256), content: z.string().max(20_000) });

/**
 * Writes a small file onto a volume, as software on its instance would. Like
 * on a real server, this isn't an AWS API call: no IAM permission is involved,
 * but the volume must be attached to a running instance.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/resources/[id]/files">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const input = body.parse(await request.json());
    const caller = await getCaller();
    const engine = getEngine();
    await engine.getTyped(caller.accountId, id, "compute", "volume");
    const files = await writeVolumeFile(
      (x) => engine.get(caller.accountId, x),
      (x, patch) => engine.setAttributes(caller.accountId, x, patch),
      id,
      input,
      engine.now(),
    );
    return Response.json({ files });
  });
}
