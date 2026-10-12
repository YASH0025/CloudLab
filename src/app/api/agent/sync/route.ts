import { syncBody } from "@/local/types";
import { getLocal, handle } from "@/server/api";

/**
 * The agent's check-in, every few seconds: what the computer looks like and what it
 * runs. The answer is the work waiting for it. Authenticated by the agent's token,
 * never by cookies.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const local = getLocal();
    const agent = await local.authenticate(request.headers.get("authorization"));
    const tasks = await local.sync(agent, syncBody.parse(await request.json()));
    return Response.json({ tasks });
  });
}
