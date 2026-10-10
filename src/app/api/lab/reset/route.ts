import { z } from "zod";
import { isRegion } from "@/engine";
import { EngineError } from "@/engine/errors";
import { getAccountId, getEngine, handle } from "@/server/api";

const body = z.object({ region: z.string() });

/** "Reset my lab": deletes everything the caller has in a region. The default VPC comes back on next use. */
export async function POST(request: Request) {
  return handle(async () => {
    const { region } = body.parse(await request.json());
    if (!isRegion(region)) throw new EngineError("InvalidParameterValue", `Invalid region: '${region}'`);
    const accountId = await getAccountId();
    const engine = getEngine();
    const removed = await engine.resetRegion(accountId, region);
    await engine.ensureDefaults(accountId, region);
    return Response.json({ region, removed });
  });
}
