import type { NextRequest } from "next/server";
import { z } from "zod";
import { APP_ACTIONS } from "@/local/types";
import { getLabAccountId, getLocal, handle } from "@/server/api";

const body = z.object({ action: z.enum(APP_ACTIONS) });

/** Start, stop, restart, redeploy or delete an app. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/local/apps/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const { action } = body.parse(await request.json());
    const app = await getLocal().action(await getLabAccountId(), id, action);
    return app ? Response.json(app) : new Response(null, { status: 204 });
  });
}
