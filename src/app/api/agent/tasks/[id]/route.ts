import type { NextRequest } from "next/server";
import { taskResult } from "@/local/types";
import { getLocal, handle } from "@/server/api";

/** The agent says a task is finished, or why it failed. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/agent/tasks/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const local = getLocal();
    const agent = await local.authenticate(request.headers.get("authorization"));
    const { status, error } = taskResult.parse(await request.json());
    await local.finishTask(agent, id, status, error);
    return new Response(null, { status: 204 });
  });
}
