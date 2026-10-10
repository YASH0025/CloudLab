import type { NextRequest } from "next/server";
import { z } from "zod";
import { toDTO } from "@/engine";
import { getAccountId, getEngine, handle } from "@/server/api";

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/resources/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const accountId = await getAccountId();
    const engine = getEngine();
    const item = await engine.get(accountId, id);
    // A default security group's rule points at itself; that isn't a dependency worth showing.
    const referencedBy = (await engine.dependents(accountId, id)).filter((r) => r.id !== id);
    return Response.json({ item: toDTO(item), referencedBy: referencedBy.map(toDTO) });
  });
}

const patchBody = z.object({ config: z.record(z.string(), z.unknown()) });

export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/resources/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = patchBody.parse(await request.json());
    const accountId = await getAccountId();
    const item = await getEngine().update(accountId, id, body.config);
    return Response.json({ item: toDTO(item) });
  });
}

export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/resources/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const accountId = await getAccountId();
    await getEngine().remove(accountId, id);
    return Response.json({ deleted: id });
  });
}
