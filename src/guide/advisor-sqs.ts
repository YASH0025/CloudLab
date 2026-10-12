import type { Engine } from "@/engine/engine";
import { countsOf } from "@/engine/sqs/queue";
import type { Suggestion } from "./types";

/**
 * Advisor rules for SQS: work piling up with nobody consuming it, messages
 * sitting in a dead-letter queue, and queues with no dead-letter queue.
 */
export async function sqsAdvice(engine: Engine, accountId: string, region: string) {
  const queues = await engine.list(accountId, { service: "sqs", type: "queue", region });
  const now = engine.now().getTime();
  const problems: Suggestion[] = [];
  const suggestions: Suggestion[] = [];
  const dlqIds = new Set(queues.map((q) => q.config.deadLetterQueue).filter(Boolean) as string[]);

  for (const q of queues) {
    const c = countsOf(q, now);
    if (dlqIds.has(q.id)) {
      if (c.available + c.inFlight > 0) {
        problems.push({
          id: `sqs-dlq-${q.id}`,
          level: "intermediate",
          title: `${c.available + c.inFlight} message(s) failed and landed in ${q.name}`,
          why: "A dead-letter queue only receives messages that failed too many times. Each one is a job that never got done: look at why before deleting it.",
          steps: [`Open ${q.name} and poll for messages: the body and DeadLetterQueueSourceArn tell you what failed and where.`, "Fix the cause, then delete the messages (or send them back to the main queue)."],
          link: { service: "sqs", type: "queue", mode: "detail", id: q.id },
          cli: `aws sqs receive-message --queue-url ${q.id} --attribute-names All`,
        });
      }
      continue;
    }
    if (c.available > 0 && c.oldestAgeSeconds > 600) {
      problems.push({
        id: `sqs-backlog-${q.id}`,
        level: "intermediate",
        title: `Messages are piling up in ${q.name}`,
        why: `${c.available} message(s) are waiting, the oldest for ${Math.floor(c.oldestAgeSeconds / 60)} minutes. Nothing is consuming the queue, or it's too slow. Unread messages are dropped after the retention period.`,
        steps: ["Check that a worker is polling the queue (and deleting what it finishes).", "Poll it yourself from the queue's page to see what's waiting."],
        link: { service: "sqs", type: "queue", mode: "detail", id: q.id },
        cli: `aws sqs get-queue-attributes --queue-url ${q.id} --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible`,
      });
    }
  }

  const noDlq = queues.find((q) => !dlqIds.has(q.id) && !q.config.deadLetterQueue);
  if (noDlq) {
    suggestions.push({
      id: "sqs-add-dlq",
      level: "intermediate",
      title: `Give ${noDlq.name} a dead-letter queue`,
      why: "Without one, a message that always fails (bad data) is retried until the retention period ends, keeping workers busy for nothing.",
      steps: ["Create a queue such as " + `${noDlq.name}-dlq.`, `Edit ${noDlq.name}: choose it as the Dead-letter queue, Maximum receives 3 to 5.`],
      link: { service: "sqs", type: "queue", mode: "create", prefill: { name: `${noDlq.name}-dlq`.slice(0, 80) } },
    });
  }
  return { problems, suggestions };
}
