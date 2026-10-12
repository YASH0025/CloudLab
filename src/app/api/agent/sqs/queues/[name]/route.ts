import type { NextRequest } from "next/server";
import { z } from "zod";
import { LOCAL_REGION } from "@/engine/catalog";
import type { Engine } from "@/engine/engine";
import { NON_EXISTENT } from "@/engine/services/sqs";
import { localSpec } from "@/local/bridge";
import { getEngine, getLocal, handle } from "@/server/api";

async function localQueue(engine: Engine, accountId: string, name: string) {
  const q = (await engine.list(accountId, { service: "sqs", type: "queue", region: LOCAL_REGION })).find((x) => x.name === name);
  if (!q) throw NON_EXISTENT();
  return q;
}

const patch = z.object({ config: z.record(z.string(), z.unknown()) });

/** SetQueueAttributes through the AWS endpoint on the learner's computer. */
export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/agent/sqs/queues/[name]">) {
  return handle(async () => {
    const agent = await getLocal().authenticate(request.headers.get("authorization"));
    const { name } = await ctx.params;
    const { config } = patch.parse(await request.json());
    const engine = getEngine();
    const q = await localQueue(engine, agent.accountId, decodeURIComponent(name));
    return Response.json(localSpec(await engine.update(agent.accountId, q.id, config)));
  });
}

/** DeleteQueue through the AWS endpoint on the learner's computer. */
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/agent/sqs/queues/[name]">) {
  return handle(async () => {
    const agent = await getLocal().authenticate(request.headers.get("authorization"));
    const { name } = await ctx.params;
    const engine = getEngine();
    const q = await localQueue(engine, agent.accountId, decodeURIComponent(name));
    await engine.remove(agent.accountId, q.id);
    return new Response(null, { status: 204 });
  });
}
