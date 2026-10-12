import type { NextRequest } from "next/server";
import { resourceReport } from "@/local/types";
import { getEngine, getLocal, handle } from "@/server/api";

/** The agent reports what really happened to a resource in My computer (local): its state and details such as ports. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/agent/resources/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const agent = await getLocal().authenticate(request.headers.get("authorization"));
    const report = resourceReport.parse(await request.json());
    await getEngine().settleLocal(agent.accountId, decodeURIComponent(id), report);
    return new Response(null, { status: 204 });
  });
}
