import type { Engine } from "@/engine/engine";
import { policyAllowsService, statsOf, type QueueStats } from "@/engine/sqs/queue";
import type { Resource } from "@/engine/types";

/** The queue the SQS tutorial suggests, and its dead-letter queue. */
export const TUTORIAL_QUEUE = "orders-queue";
export const TUTORIAL_DLQ = "orders-dlq";

/** What the SQS tutorial looks at. */
export interface QueuesState {
  queue?: Resource;
  stats: QueueStats;
  /** A queue that could serve as the dead-letter queue (not the main one). */
  dlq?: Resource;
  /** The main queue's redrive policy points at a queue. */
  redrive: boolean;
  /** A topic subscribed to the queue whose policy lets it send. */
  topic?: Resource;
  subscribed: boolean;
  topicAllowed: boolean;
}

export async function loadQueues(engine: Engine, accountId: string, region: string): Promise<QueuesState> {
  const list = (service: string, type: string) => engine.list(accountId, { service, type, region });
  const [queues, subs, topics] = await Promise.all([list("sqs", "queue"), list("sns", "subscription"), list("sns", "topic")]);
  const dlqIds = new Set(queues.map((q) => q.config.deadLetterQueue).filter(Boolean));
  const queue = queues.find((q) => q.name === TUTORIAL_QUEUE) ?? queues.find((q) => !dlqIds.has(q.id) && q.name !== TUTORIAL_DLQ);
  const dlq = queue?.config.deadLetterQueue ? queues.find((q) => q.id === queue.config.deadLetterQueue) : (queues.find((q) => q.name === TUTORIAL_DLQ) ?? queues.find((q) => q !== queue));
  const arn = String(queue?.attributes.arn ?? "");
  const sub = subs.find((s) => s.config.protocol === "sqs" && s.config.endpoint === arn);
  const topic = sub ? topics.find((t) => t.id === sub.config.topicArn) : topics[0];
  return {
    queue,
    stats: queue ? statsOf(queue) : statsOf({ attributes: {} } as Resource),
    dlq,
    redrive: !!queue?.config.deadLetterQueue,
    topic,
    subscribed: !!sub,
    topicAllowed: !!(queue && sub && policyAllowsService(queue, "sns.amazonaws.com", "sqs:SendMessage", String(sub.config.topicArn))),
  };
}
