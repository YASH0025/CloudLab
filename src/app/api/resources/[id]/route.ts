import type { NextRequest } from "next/server";
import { z } from "zod";
import { toDTO } from "@/engine";
import { getTypeDef } from "@/engine/registry";
import { authorizeConsole, getCaller, getEngine, handle } from "@/server/api";

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/resources/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const caller = await getCaller();
    const { accountId } = caller;
    const engine = getEngine();
    const item = await engine.get(accountId, id);
    authorizeConsole(caller, { kind: "read" }, item, item, item.region);
    // A default security group's rule points at itself; that isn't a dependency worth showing.
    // Objects in a bucket are shown in the bucket's own object browser instead.
    const referencedBy = (await engine.dependents(accountId, id)).filter((r) => r.id !== id && !getTypeDef(r.service, r.type).hidden);
    return Response.json({ item: toDTO(item), referencedBy: referencedBy.map(toDTO) });
  });
}

const patchBody = z.object({ config: z.record(z.string(), z.unknown()) });

export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/resources/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = patchBody.parse(await request.json());
    const caller = await getCaller();
    const existing = await getEngine().get(caller.accountId, id);
    const norm = (v: unknown) => JSON.stringify(v === "" || v === null || v === undefined ? null : v);
    const changed = Object.keys(body.config).filter((k) => norm(body.config[k]) !== norm(existing.config[k]));
    if (changed.length > 0) authorizeConsole(caller, { kind: "update", changed }, existing, existing, existing.region);
    const item = await getEngine().update(caller.accountId, id, body.config);
    return Response.json({ item: toDTO(item) });
  });
}

export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/resources/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const caller = await getCaller();
    const existing = await getEngine().get(caller.accountId, id);
    authorizeConsole(caller, { kind: "delete" }, existing, existing, existing.region);
    await getEngine().remove(caller.accountId, id);
    return Response.json({ deleted: id });
  });
}
