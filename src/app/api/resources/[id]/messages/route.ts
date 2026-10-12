import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Engine } from "@/engine/engine";
import { EngineError } from "@/engine/errors";
import { countsOf, deleteMessage, purgeQueue, receiveMessages, sendMessage, snsSendStatement, withStatement } from "@/engine/sqs/queue";
import type { Resource } from "@/engine/types";
import { authorizeActions, getCaller, getEngine, handle, type Caller } from "@/server/api";

/**
 * A queue's "Send and receive messages" page: counts, send, poll, delete,
 * purge, and "Subscribe to Amazon SNS topic" (which, like the SQS console,
 * also lets the topic send to the queue).
 */

const attributes = z.record(z.string(), z.object({ DataType: z.string(), StringValue: z.string() })).default({});
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send"), body: z.string(), delaySeconds: z.number().int().optional(), attributes }),
  z.object({ action: z.literal("receive"), maxNumberOfMessages: z.number().int().default(10), visibilityTimeout: z.number().int().optional() }),
  z.object({ action: z.literal("delete"), receiptHandle: z.string() }),
  z.object({ action: z.literal("purge") }),
  z.object({ action: z.literal("subscribe"), topicArn: z.string() }),
]);

async function queueOf(engine: Engine, caller: Caller, id: string): Promise<Resource> {
  const q = await engine.get(caller.accountId, id);
  if (q.service !== "sqs" || q.type !== "queue") throw new EngineError("ValidationError", "Only SQS queues have messages.");
  return q;
}

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/resources/[id]/messages">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const caller = await getCaller();
    const engine = getEngine();
    const q = await queueOf(engine, caller, id);
    authorizeActions(caller, [{ action: "sqs:GetQueueAttributes", resource: String(q.attributes.arn) }]);
    return Response.json({ counts: countsOf(q, engine.now().getTime()) });
  });
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/messages">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const input = body.parse(await request.json().catch(() => ({})));
    const caller = await getCaller();
    const engine = getEngine();
    const q = await queueOf(engine, caller, id);
    const arn = String(q.attributes.arn);
    switch (input.action) {
      case "send":
        authorizeActions(caller, [{ action: "sqs:SendMessage", resource: arn }]);
        return Response.json({ sent: await sendMessage(engine, q, { body: input.body, delaySeconds: input.delaySeconds, attributes: input.attributes }) });
      case "receive": {
        authorizeActions(caller, [{ action: "sqs:ReceiveMessage", resource: arn }]);
        const r = await receiveMessages(engine, q, {
          maxNumberOfMessages: input.maxNumberOfMessages,
          visibilityTimeout: input.visibilityTimeout,
          attributeNames: ["All"],
          messageAttributeNames: ["All"],
        });
        return Response.json(r);
      }
      case "delete":
        authorizeActions(caller, [{ action: "sqs:DeleteMessage", resource: arn }]);
        await deleteMessage(engine, q, input.receiptHandle);
        return Response.json({ deleted: true });
      case "purge":
        authorizeActions(caller, [{ action: "sqs:PurgeQueue", resource: arn }]);
        await purgeQueue(engine, q);
        return Response.json({ purged: true });
      case "subscribe": {
        const topic = await engine.get(caller.accountId, input.topicArn);
        if (topic.service !== "sns" || topic.type !== "topic") throw new EngineError("ValidationError", "Choose an SNS topic.");
        authorizeActions(caller, [
          { action: "sqs:SetQueueAttributes", resource: arn },
          { action: "sns:Subscribe", resource: topic.id },
        ]);
        await engine.update(caller.accountId, q.id, { policy: withStatement(q, snsSendStatement(q, topic.id)) });
        const existing = (await engine.list(caller.accountId, { service: "sns", type: "subscription", region: topic.region })).find(
          (s) => s.config.topicArn === topic.id && s.config.protocol === "sqs" && s.config.endpoint === arn,
        );
        const sub =
          existing ?? (await engine.create(caller.accountId, { service: "sns", type: "subscription", region: topic.region, config: { topicArn: topic.id, protocol: "sqs", endpoint: arn } }));
        return Response.json({ subscriptionArn: sub.id });
      }
    }
  });
}
