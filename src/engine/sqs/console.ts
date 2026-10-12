import type { ServiceHost } from "../host";
import type { MessageAttribute } from "../services/sns";
import type { Resource } from "../types";
import { countsOf, deleteMessage, purgeQueue, receiveMessages, sendMessage } from "./queue";

/**
 * A queue's "Send and receive messages" page: counts, send, poll, delete and
 * purge. The same code runs on CloudLab's servers and, for queues on My computer
 * (local), in the agent. (Subscribing to an SNS topic stays on the server route.)
 */

export type QueueConsoleInput =
  | { action: "counts" }
  | { action: "send"; body: string; delaySeconds?: number; attributes: Record<string, MessageAttribute> }
  | { action: "receive"; maxNumberOfMessages: number; visibilityTimeout?: number }
  | { action: "delete"; receiptHandle: string }
  | { action: "purge" };

/** The IAM action a console request needs. */
export const queueConsoleAction = (input: QueueConsoleInput) =>
  ({ counts: "sqs:GetQueueAttributes", send: "sqs:SendMessage", receive: "sqs:ReceiveMessage", delete: "sqs:DeleteMessage", purge: "sqs:PurgeQueue" })[input.action];

export async function queueConsole(host: ServiceHost, q: Resource, input: QueueConsoleInput, onSent?: () => void) {
  switch (input.action) {
    case "counts":
      return { counts: countsOf(await host.get(q.accountId, q.id), host.now().getTime()) };
    case "send": {
      const sent = await sendMessage(host, q, { body: input.body, delaySeconds: input.delaySeconds, attributes: input.attributes });
      onSent?.();
      return { sent };
    }
    case "receive":
      return receiveMessages(host, q, {
        maxNumberOfMessages: input.maxNumberOfMessages,
        visibilityTimeout: input.visibilityTimeout,
        attributeNames: ["All"],
        messageAttributeNames: ["All"],
      });
    case "delete":
      await deleteMessage(host, q, input.receiptHandle);
      return { deleted: true };
    case "purge":
      await purgeQueue(host, q);
      return { purged: true };
  }
}
