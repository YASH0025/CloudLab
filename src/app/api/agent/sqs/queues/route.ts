import { z } from "zod";
import { LOCAL_REGION } from "@/engine/catalog";
import { localSpec } from "@/local/bridge";
import { getEngine, getLocal, handle } from "@/server/api";

const body = z.object({ config: z.record(z.string(), z.unknown()) });

/**
 * CreateQueue through the AWS endpoint on the learner's computer (an SDK or
 * `aws sqs create-queue`): the queue becomes a CloudLab queue in My computer
 * (local), with SQS's checks and errors. The agent keeps its messages.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const agent = await getLocal().authenticate(request.headers.get("authorization"));
    const { config } = body.parse(await request.json());
    const q = await getEngine().create(agent.accountId, { service: "sqs", type: "queue", region: LOCAL_REGION, config });
    return Response.json(localSpec(q), { status: 201 });
  });
}
