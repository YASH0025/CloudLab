import type { NextRequest } from "next/server";
import { isRegion } from "@/engine";
import { EngineError } from "@/engine/errors";
import { buildDiagram } from "@/guide/diagram";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

/** The network diagram for a region: ?region= */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const region = request.nextUrl.searchParams.get("region") ?? "us-east-1";
    if (!isRegion(region)) throw new EngineError("InvalidParameterValue", `Invalid region: '${region}'`);
    const caller = await getCaller();
    // Drawing the network reads the same things describe-vpcs and friends do.
    authorizeActions(caller, [{ action: "ec2:DescribeVpcs", resource: "*" }]);
    const engine = getEngine();
    await engine.ensureDefaults(caller.accountId, region);
    return Response.json({ diagram: await buildDiagram(engine, caller.accountId, region) });
  });
}
