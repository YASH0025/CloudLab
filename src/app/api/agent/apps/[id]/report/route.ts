import type { NextRequest } from "next/server";
import { appReport } from "@/local/types";
import { getLocal, handle } from "@/server/api";

/** Progress on one app while the agent works on it: downloading, building, starting, its logs. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/agent/apps/[id]/report">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const local = getLocal();
    const agent = await local.authenticate(request.headers.get("authorization"));
    await local.report(agent, id, appReport.parse(await request.json()));
    return new Response(null, { status: 204 });
  });
}
