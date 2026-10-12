import type { NextRequest } from "next/server";
import { z } from "zod";
import { APP_ACTIONS, domainSchema } from "@/local/types";
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

const patch = z.object({ domain: domainSchema.nullable().or(z.literal("").transform(() => null)) });

/** Set or remove the app's name on the home network. */
export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/local/apps/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const { domain } = patch.parse(await request.json());
    return Response.json(await getLocal().setDomain(await getLabAccountId(), id, domain));
  });
}
