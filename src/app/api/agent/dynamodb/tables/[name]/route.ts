import type { NextRequest } from "next/server";
import { z } from "zod";
import { LOCAL_REGION } from "@/engine/catalog";
import type { Engine } from "@/engine/engine";
import { tableNotFound } from "@/engine/services/dynamodb";
import { tableSpec } from "@/local/bridge";
import { getEngine, getLocal, handle } from "@/server/api";

async function localTable(engine: Engine, accountId: string, name: string) {
  const t = (await engine.list(accountId, { service: "dynamodb", type: "table", region: LOCAL_REGION })).find((x) => x.name === name);
  if (!t) throw tableNotFound(name);
  return t;
}

const patch = z.object({ config: z.record(z.string(), z.unknown()) });

/** UpdateTable and UpdateTimeToLive through the AWS endpoint on the learner's computer. */
export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/agent/dynamodb/tables/[name]">) {
  return handle(async () => {
    const agent = await getLocal().authenticate(request.headers.get("authorization"));
    const { name } = await ctx.params;
    const { config } = patch.parse(await request.json());
    const engine = getEngine();
    const t = await localTable(engine, agent.accountId, decodeURIComponent(name));
    return Response.json(tableSpec(await engine.update(agent.accountId, t.id, config)));
  });
}

/** DeleteTable through the AWS endpoint on the learner's computer. */
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/agent/dynamodb/tables/[name]">) {
  return handle(async () => {
    const agent = await getLocal().authenticate(request.headers.get("authorization"));
    const { name } = await ctx.params;
    const engine = getEngine();
    const t = await localTable(engine, agent.accountId, decodeURIComponent(name));
    await engine.remove(agent.accountId, t.id);
    return new Response(null, { status: 204 });
  });
}
