import type { NextRequest } from "next/server";
import { z } from "zod";
import { LOCAL_REGION } from "@/engine/catalog";
import { localSpec, localType } from "@/local/bridge";
import { getEngine, getLocal, handle } from "@/server/api";

const body = z.object({ config: z.record(z.string(), z.unknown()) });

/**
 * Creates a resource in My computer (local) for a call to the agent's AWS endpoint
 * (an SDK or the AWS CLI): CloudLab keeps the record, with its checks and errors,
 * and the agent keeps the data. Answers with what the agent needs to know about it.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/agent/local/[service]/[type]">) {
  return handle(async () => {
    const agent = await getLocal().authenticate(request.headers.get("authorization"));
    const { service, type } = await ctx.params;
    localType(service, type);
    const { config } = body.parse(await request.json());
    const engine = getEngine();
    const r = await engine.create(agent.accountId, { service, type, region: LOCAL_REGION, config });
    // Hooks (confirming a queue subscription…) may have changed it straight away.
    return Response.json(localSpec(await engine.get(agent.accountId, r.id)), { status: 201 });
  });
}
