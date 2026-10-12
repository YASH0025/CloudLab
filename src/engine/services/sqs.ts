import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import type { FieldDef, ResourceTypeDef, ServiceDef } from "../types";

/**
 * SQS standard queues. A queue holds messages until a consumer receives and
 * deletes them; a received message is hidden for the visibility timeout and
 * comes back if it isn't deleted in time. Messages (sqs/queue.ts) are kept on
 * the queue, server-side only.
 */

export const queueUrl = (region: string, accountId: string, name: string) => `https://sqs.${region}.amazonaws.com/${accountNumber(accountId)}/${name}`;
export const queueArn = (region: string, accountId: string, name: string) => `arn:aws:sqs:${region}:${accountNumber(accountId)}:${name}`;
/** The queue URL for a queue ARN (they hold the same three parts). */
export const urlFromArn = (arn: string) => {
  const [, , , region, account, name] = arn.split(":");
  return `https://sqs.${region}.amazonaws.com/${account}/${name}`;
};

export const QUEUE_URL = /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]{1,80}$/;
export const QUEUE_ARN = /^arn:aws:sqs:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,80}$/;

export const NON_EXISTENT = () => new EngineError("AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.", 400);

/** Settings with their API names, limits and defaults, as CreateQueue/SetQueueAttributes know them. */
export const QUEUE_SETTINGS = {
  visibilityTimeout: { attr: "VisibilityTimeout", min: 0, max: 43200, default: 30 },
  messageRetentionPeriod: { attr: "MessageRetentionPeriod", min: 60, max: 1209600, default: 345600 },
  delaySeconds: { attr: "DelaySeconds", min: 0, max: 900, default: 0 },
  receiveMessageWaitTimeSeconds: { attr: "ReceiveMessageWaitTimeSeconds", min: 0, max: 20, default: 0 },
  maximumMessageSize: { attr: "MaximumMessageSize", min: 1024, max: 262144, default: 262144 },
} as const;

export type QueueSetting = keyof typeof QUEUE_SETTINGS;

const setting = (key: QueueSetting, label: string, description: string): FieldDef => {
  const s = QUEUE_SETTINGS[key];
  return { key, label, type: "number", required: true, default: s.default, min: s.min, max: s.max, param: s.attr, description };
};

const queue: ResourceTypeDef = {
  service: "sqs",
  type: "queue",
  label: "Queue",
  pluralLabel: "Queues",
  description:
    "A waiting line for messages. Producers send to it, consumers receive and delete when done. If the consumer is slow or crashes, the messages wait safely instead of being lost.",
  idPrefix: "queue",
  makeId: ({ name, region, accountId }) => queueUrl(region, accountId, name),
  idPattern: QUEUE_URL,
  notFoundCode: "AWS.SimpleQueueService.NonExistentQueue",
  notFoundMessage: () => "The specified queue does not exist.",
  notFoundByNameMessage: () => "The specified queue does not exist.",
  malformedCode: "AWS.SimpleQueueService.NonExistentQueue",
  malformedMessage: () => "The specified queue does not exist.",
  apiNoun: "queue",
  privateAttributes: ["messages"],
  panelAttributes: ["lastPurgeAt", "stats"],
  fields: [
    {
      key: "name",
      label: "Name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 80,
      pattern: "^[A-Za-z0-9_-]+$",
      patternMessage: "Up to 80 letters, numbers, hyphens and underscores.",
      placeholder: "orders-queue",
      param: "QueueName",
      description: "Becomes part of the queue's URL, which is how you send to and receive from it.",
    },
    setting("visibilityTimeout", "Visibility timeout (seconds)", "After a consumer receives a message, it's hidden from others this long. Delete it in time, or it comes back to be tried again. Set it longer than processing takes."),
    setting("messageRetentionPeriod", "Message retention period (seconds)", "Messages nobody deletes are dropped after this long: 60 seconds to 14 days (1,209,600). Default 4 days (345,600)."),
    setting("delaySeconds", "Delivery delay (seconds)", "New messages stay invisible this long before anyone can receive them (0 to 900)."),
    setting("receiveMessageWaitTimeSeconds", "Receive message wait time (seconds)", "Long polling: a receive waits up to this long for a message instead of returning empty straight away (0 to 20)."),
    setting("maximumMessageSize", "Maximum message size (bytes)", "From 1,024 to 262,144 (256 KB)."),
    {
      key: "deadLetterQueue",
      label: "Dead-letter queue",
      type: "ref",
      ref: { service: "sqs", type: "queue", weak: true },
      param: "RedrivePolicy",
      description: "Optional. A message received too many times without being deleted (a 'poison' message that keeps failing) is moved here, so it stops blocking the others.",
    },
    {
      key: "maxReceiveCount",
      label: "Maximum receives",
      type: "number",
      min: 1,
      max: 1000,
      default: 10,
      param: "RedrivePolicy",
            description: "How many times a message may be received before it's moved to the dead-letter queue.",
    },
    {
      key: "policy",
      label: "Access policy",
      type: "json",
      param: "Policy",
      description:
        "Optional. Who else may use the queue, e.g. letting an SNS topic send to it. Your own account's users and roles don't need it: their IAM policies are enough.",
    },
  ],
  columns: [
    { label: "Visibility timeout", path: "config.visibilityTimeout" },
    { label: "Dead-letter queue", path: "attributes.deadLetterName" },
  ],
  iam: {
    create: "sqs:CreateQueue",
    read: "sqs:GetQueueAttributes",
    update: "sqs:SetQueueAttributes",
    delete: "sqs:DeleteQueue",
    arn: (r, account) => `arn:aws:sqs:${r.region}:${account}:${r.name}`,
  },
  invalidValue({ field, value }) {
    if (field.key === "name") {
      if (typeof value === "string" && value.endsWith(".fifo")) {
        return new EngineError("InvalidParameterValue", "Nuvora simulates standard queues; FIFO queues (ending in .fifo) aren't available yet.");
      }
      return new EngineError("InvalidParameterValue", "Can only include alphanumeric characters, hyphens, or underscores. 1 to 80 in length");
    }
    const s = (QUEUE_SETTINGS as Record<string, { attr: string }>)[field.key];
    if (s) return new EngineError("InvalidAttributeValue", `Invalid value for the parameter ${s.attr}.`);
    if (field.key === "maxReceiveCount") return new EngineError("InvalidParameterValue", "Value {\"maxReceiveCount\":\"" + String(value) + "\"} for parameter RedrivePolicy is invalid. Reason: Invalid value for maxReceiveCount: " + String(value) + ", valid values are from 1 to 1000 both inclusive.");
    if (field.key === "policy") return new EngineError("InvalidAttributeValue", "Invalid value for the parameter Policy.");
    return undefined;
  },
  async validate({ config, existing, ctx }) {
    if (!existing && (await ctx.list("sqs", "queue")).some((q) => q.name === config.name)) {
      throw new EngineError("QueueAlreadyExists", "A queue already exists with the same name and a different value for an attribute.", 400);
    }
    if (config.deadLetterQueue && existing && config.deadLetterQueue === existing.id) {
      throw new EngineError("InvalidParameterValue", "Value for parameter RedrivePolicy is invalid. Reason: A queue can't be its own dead-letter queue.");
    }
    if (config.policy) {
      let doc: unknown;
      try {
        doc = JSON.parse(String(config.policy));
      } catch {
        throw new EngineError("InvalidAttributeValue", "Invalid value for the parameter Policy.");
      }
      const st = (doc as { Statement?: unknown })?.Statement;
      if (!doc || typeof doc !== "object" || !(Array.isArray(st) || (st && typeof st === "object"))) {
        throw new EngineError("InvalidAttributeValue", "Invalid value for the parameter Policy. Reason: the policy must have a Statement.");
      }
    }
  },
  async derive({ id, config, existing, ctx }) {
    const name = String(config.name);
    const dlq = config.deadLetterQueue ? String(config.deadLetterQueue) : null;
    return {
      ...(existing?.attributes ?? {}),
      arn: queueArn(ctx.region, ctx.accountId, name),
      queueUrl: id,
      deadLetterName: dlq ? dlq.split("/").pop() : null,
      messages: existing?.attributes.messages ?? [],
    };
  },
};

export const sqsService: ServiceDef = {
  id: "sqs",
  label: "Simple Queue Service",
  modelledOn: "Amazon SQS",
  description: "Queues that hold messages until a worker is ready, so a slow or failing part doesn't lose work.",
  category: "Integration",
  types: [queue],
};
