import { EngineError } from "../errors";
import { QUEUE_ARN, QUEUE_SETTINGS, urlFromArn, type QueueSetting } from "../services/sqs";
import type { Resource } from "../types";
import { countsOf } from "./queue";

/**
 * A queue's attributes as SQS's API names them (VisibilityTimeout, RedrivePolicy…),
 * to and from CloudLab's queue settings. Shared by the CLI and the SQS API.
 */

const SETTING_BY_ATTR = Object.fromEntries(Object.entries(QUEUE_SETTINGS).map(([key, s]) => [s.attr, key as QueueSetting]));
const READ_ONLY = ["QueueArn", "ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed", "CreatedTimestamp", "LastModifiedTimestamp", "SqsManagedSseEnabled"];
export const KNOWN_ATTRIBUTES = [...Object.keys(SETTING_BY_ATTR), "Policy", "RedrivePolicy", ...READ_ONLY];

/** arn:aws:sqs:region:account:name for a queue URL (they hold the same three parts). */
export const arnFromUrl = (url: string) => {
  const m = /^https?:\/\/[^/]*?(?:sqs\.([a-z0-9-]+)\.[^/]*)?\/(\d{12})\/([^/]+)$/.exec(url);
  return m ? `arn:aws:sqs:${m[1] ?? "local-1"}:${m[2]}:${m[3]}` : url;
};

/** Turns API attributes into the queue's settings, with SQS's errors. A RedrivePolicy leaves `_redrive` for checkDeadLetterQueue. */
export function attributesToConfig(attrs: Record<string, string>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attrs)) {
    const key = SETTING_BY_ATTR[name];
    if (key) {
      const n = Number(value);
      const s = QUEUE_SETTINGS[key];
      if (!/^\d+$/.test(value) || n < s.min || n > s.max) throw new EngineError("InvalidAttributeValue", `Invalid value for the parameter ${name}.`);
      config[key] = n;
    } else if (name === "Policy") {
      config.policy = value === "" ? undefined : value;
    } else if (name === "RedrivePolicy") {
      if (value === "") {
        config.deadLetterQueue = undefined;
        continue;
      }
      let rp: { deadLetterTargetArn?: string; maxReceiveCount?: string | number };
      try {
        rp = JSON.parse(value);
      } catch {
        throw new EngineError("InvalidParameterValue", `Value ${value} for parameter RedrivePolicy is invalid. Reason: Redrive policy is not a valid JSON map.`);
      }
      if (!rp.deadLetterTargetArn || !QUEUE_ARN.test(rp.deadLetterTargetArn)) {
        throw new EngineError("InvalidParameterValue", `Value ${value} for parameter RedrivePolicy is invalid. Reason: Invalid value for deadLetterTargetArn.`);
      }
      const count = Number(rp.maxReceiveCount);
      if (!Number.isInteger(count) || count < 1 || count > 1000) {
        throw new EngineError(
          "InvalidParameterValue",
          `Value ${value} for parameter RedrivePolicy is invalid. Reason: Invalid value for maxReceiveCount: ${rp.maxReceiveCount}, valid values are from 1 to 1000 both inclusive.`,
        );
      }
      config.deadLetterQueue = urlFromArn(rp.deadLetterTargetArn);
      config.maxReceiveCount = count;
      config._redrive = value;
    } else if (READ_ONLY.includes(name)) {
      throw new EngineError("InvalidAttributeName", `Unknown Attribute ${name}.`);
    } else if (name === "FifoQueue" || name === "ContentBasedDeduplication") {
      throw new EngineError("InvalidAttributeName", `Unknown Attribute ${name}. (CloudLab simulates standard queues; FIFO queues aren't available yet.)`);
    } else {
      throw new EngineError("InvalidAttributeName", `Unknown Attribute ${name}.`);
    }
  }
  return config;
}

/** The DLQ must exist; SQS checks when the redrive policy is set. */
export async function checkDeadLetterQueue(config: Record<string, unknown>, queueIds: () => Promise<string[]>) {
  if (!config.deadLetterQueue) {
    delete config._redrive;
    return;
  }
  const raw = String(config._redrive);
  delete config._redrive;
  const exists = (await queueIds()).includes(String(config.deadLetterQueue));
  if (!exists) throw new EngineError("InvalidParameterValue", `Value ${raw} for parameter RedrivePolicy is invalid. Reason: Dead letter target does not exist.`);
}

const epoch = (iso: string) => String(Math.floor(Date.parse(iso) / 1000));

/** Every attribute GetQueueAttributes returns. */
export function queueAttributes(q: Resource, now: number): Record<string, string> {
  const c = countsOf(q, now);
  return {
    QueueArn: String(q.attributes.arn),
    ApproximateNumberOfMessages: String(c.available),
    ApproximateNumberOfMessagesNotVisible: String(c.inFlight),
    ApproximateNumberOfMessagesDelayed: String(c.delayed),
    CreatedTimestamp: epoch(q.createdAt),
    LastModifiedTimestamp: epoch(q.updatedAt),
    VisibilityTimeout: String(q.config.visibilityTimeout),
    MaximumMessageSize: String(q.config.maximumMessageSize),
    MessageRetentionPeriod: String(q.config.messageRetentionPeriod),
    DelaySeconds: String(q.config.delaySeconds),
    ...(q.config.policy ? { Policy: JSON.stringify(JSON.parse(String(q.config.policy))) } : {}),
    ...(q.config.deadLetterQueue
      ? {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: arnFromUrl(String(q.config.deadLetterQueue)),
            maxReceiveCount: Number(q.config.maxReceiveCount ?? 10),
          }),
        }
      : {}),
    ReceiveMessageWaitTimeSeconds: String(q.config.receiveMessageWaitTimeSeconds),
    SqsManagedSseEnabled: "true",
  };
}

