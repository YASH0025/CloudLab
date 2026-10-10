import type { NextRequest } from "next/server";
import { z } from "zod";
import { toDTO } from "@/engine";
import { authorizeConsole, getCaller, getEngine, handle } from "@/server/api";

const actionBody = z.object({ action: z.string().min(1) });

/** Runs a lifecycle action such as start, stop, reboot or terminate. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/actions">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const { action } = actionBody.parse(await request.json());
    const caller = await getCaller();
    const existing = await getEngine().get(caller.accountId, id);
    authorizeConsole(caller, { kind: "action", action }, existing, existing, existing.region);
    const item = await getEngine().runAction(caller.accountId, id, action);
    return Response.json({ item: toDTO(item) });
  });
}
