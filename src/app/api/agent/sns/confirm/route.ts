import { z } from "zod";
import { LOCAL_REGION } from "@/engine/catalog";
import { EngineError } from "@/engine/errors";
import { confirmSubscription } from "@/engine/sns/publish";
import { localSpec } from "@/local/bridge";
import { getEngine, getLocal, handle } from "@/server/api";

const body = z.object({ topicArn: z.string().max(300), token: z.string().max(200) });

/** ConfirmSubscription through the agent: an app visiting its SubscribeURL, or an SDK call. */
export async function POST(request: Request) {
  return handle(async () => {
    const agent = await getLocal().authenticate(request.headers.get("authorization"));
    const { topicArn, token } = body.parse(await request.json());
    const engine = getEngine();
    const topic = await engine.getTyped(agent.accountId, topicArn, "sns", "topic", LOCAL_REGION).catch(() => null);
    if (!topic || topic.region !== LOCAL_REGION) throw new EngineError("NotFound", "Topic does not exist", 404);
    return Response.json(localSpec(await confirmSubscription(engine, agent.accountId, topic, token)));
  });
}
