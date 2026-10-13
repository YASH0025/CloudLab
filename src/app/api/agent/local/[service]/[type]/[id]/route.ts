import type { NextRequest } from "next/server";
import { z } from "zod";
import { LOCAL_REGION } from "@/engine/catalog";
import { EngineError } from "@/engine/errors";
import { localSpec, localType } from "@/local/bridge";
import { getEngine, getLocal, handle } from "@/server/api";

const patch = z.object({ config: z.record(z.string(), z.unknown()) });

async function target(request: NextRequest, params: Promise<{ service: string; type: string; id: string }>) {
  const agent = await getLocal().authenticate(request.headers.get("authorization"));
  const { service, type, id } = await params;
  localType(service, type);
  const engine = getEngine();
  const r = await engine.getTyped(agent.accountId, decodeURIComponent(id), service, type, LOCAL_REGION);
  if (r.region !== LOCAL_REGION) throw new EngineError("NotFound", "Not on My computer (local).", 404);
  return { agent, engine, r };
}

/** Changes a local resource's settings (SetTopicAttributes, SetSubscriptionAttributes…). */
export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/agent/local/[service]/[type]/[id]">) {
  return handle(async () => {
    const { agent, engine, r } = await target(request, ctx.params);
    const { config } = patch.parse(await request.json());
    return Response.json(localSpec(await engine.update(agent.accountId, r.id, config)));
  });
}

/** Deletes a local resource (DeleteTopic, Unsubscribe…). */
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/agent/local/[service]/[type]/[id]">) {
  return handle(async () => {
    const { agent, engine, r } = await target(request, ctx.params);
    await engine.remove(agent.accountId, r.id);
    return new Response(null, { status: 204 });
  });
}
