import { z } from "zod";
import { LOCAL_REGION } from "@/engine/catalog";
import { tableSpec } from "@/local/bridge";
import { getEngine, getLocal, handle } from "@/server/api";

const body = z.object({ config: z.record(z.string(), z.unknown()) });

/**
 * CreateTable through the AWS endpoint on the learner's computer (an SDK or
 * `aws dynamodb create-table`): the table becomes a CloudLab table in My computer
 * (local), with DynamoDB's checks and errors. The agent keeps its items.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const agent = await getLocal().authenticate(request.headers.get("authorization"));
    const { config } = body.parse(await request.json());
    const t = await getEngine().create(agent.accountId, { service: "dynamodb", type: "table", region: LOCAL_REGION, config });
    return Response.json(tableSpec(t), { status: 201 });
  });
}
