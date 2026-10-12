import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LOCAL_REGION } from "../catalog";
import type { ServiceHost } from "../host";
import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import type { MessageAttribute } from "../services/sns";
import type { Resource } from "../types";

/**
 * What happens to messages in a queue: sending (with an optional delay),
 * receiving (which hides them for the visibility timeout and counts the
 * receive), deleting by receipt handle, changing visibility, purging, retention
 * and the redrive to a dead-letter queue. There are no background jobs: a
 * queue catches up whenever it's used.
 */

export interface StoredMessage {
  messageId: string;
  body: string;
  md5: string;
  attributes: Record<string, MessageAttribute>;
  sentAt: number;
  /** Can be received from this time (delays and visibility timeouts push it later). */
  visibleAt: number;
  receiveCount: number;
  firstReceivedAt?: number;
  /** The handle from the latest receive; only it can delete or change the message. */
  receiptHandle?: string;
  senderId: string;
  /** Moved here from another queue by its redrive policy. */
  deadLetterSourceArn?: string;
}

export interface ReceivedMessage {
  MessageId: string;
  ReceiptHandle: string;
  MD5OfBody: string;
  Body: string;
  Attributes?: Record<string, string>;
  MD5OfMessageAttributes?: string;
  MessageAttributes?: Record<string, { StringValue?: string; DataType: string }>;
}

export interface QueueCounts {
  /** ApproximateNumberOfMessages: ready to be received. */
  available: number;
  /** ApproximateNumberOfMessagesNotVisible: received and not yet deleted (in flight). */
  inFlight: number;
  /** ApproximateNumberOfMessagesDelayed. */
  delayed: number;
  /** Age of the oldest message, in seconds. */
  oldestAgeSeconds: number;
}

/** CloudLab's limits: real queues hold unlimited messages. */
export const MAX_MESSAGES = 1000;
export const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const PURGE_COOLDOWN_MS = 60_000;

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/** The MD5 of message attributes, computed the way SQS documents it. */
export function md5OfAttributes(attrs: Record<string, MessageAttribute>): string {
  const parts: Buffer[] = [];
  const lenPrefixed = (b: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    parts.push(len, b);
  };
  for (const name of Object.keys(attrs).sort()) {
    const a = attrs[name];
    lenPrefixed(Buffer.from(name));
    lenPrefixed(Buffer.from(a.DataType));
    parts.push(Buffer.from([1]));
    lenPrefixed(Buffer.from(a.StringValue ?? ""));
  }
  return createHash("md5").update(Buffer.concat(parts)).digest("hex");
}

const messagesOf = (q: Resource) => (q.attributes.messages as StoredMessage[] | undefined) ?? [];
const num = (q: Resource, key: string) => Number(q.config[key]);
const arnOf = (q: Resource) => String(q.attributes.arn);

/** Drops messages past the retention period. */
function retained(q: Resource, msgs: StoredMessage[], now: number) {
  const keepMs = num(q, "messageRetentionPeriod") * 1000;
  return msgs.filter((m) => now - m.sentAt < keepMs);
}

export function countsOf(q: Resource, now: number): QueueCounts {
  const msgs = retained(q, messagesOf(q), now);
  const delayed = msgs.filter((m) => m.receiveCount === 0 && m.visibleAt > now).length;
  const inFlight = msgs.filter((m) => m.receiveCount > 0 && m.visibleAt > now).length;
  const oldest = msgs.reduce((min, m) => Math.min(min, m.sentAt), now);
  return { available: msgs.length - delayed - inFlight, inFlight, delayed, oldestAgeSeconds: Math.floor((now - oldest) / 1000) };
}

/** Running totals, for the console and the guide ("has a message ever come back?"). */
export interface QueueStats {
  sent: number;
  received: number;
  deleted: number;
  /** Receives of a message that had been received before (its visibility timeout ran out). */
  redelivered: number;
  movedToDlq: number;
  /** Messages an SNS topic delivered. */
  fromSns: number;
}

export const statsOf = (q: Resource): QueueStats => ({ sent: 0, received: 0, deleted: 0, redelivered: 0, movedToDlq: 0, fromSns: 0, ...((q.attributes.stats as Partial<QueueStats> | undefined) ?? {}) });

/** The queue as it is now. A queue on My computer (local) keeps its messages there, so only the agent can use them. */
async function load(engine: ServiceHost, q: Resource): Promise<Resource> {
  if (q.region === LOCAL_REGION && !engine.holdsLocalItems) {
    throw new EngineError(
      "LocalQueue",
      `The messages of ${q.name} are on your computer (My computer (local)), not on CloudLab's servers. Use the console on that computer, or an AWS SDK or the AWS CLI with the endpoint http://localhost:4566.`,
      400,
    );
  }
  return engine.get(q.accountId, q.id);
}

async function save(engine: ServiceHost, q: Resource, msgs: StoredMessage[], extra: Record<string, unknown> = {}, add: Partial<QueueStats> = {}) {
  const stats = statsOf(q);
  for (const [k, v] of Object.entries(add)) stats[k as keyof QueueStats] += v ?? 0;
  await engine.setAttributes(q.accountId, q.id, { messages: msgs, stats, ...extra });
}

/** SNS's sender ID on messages it delivers to queues. */
export const SNS_SENDER = "AIDAIT2UOQQY3AUEKVGXU";

function checkAttributes(attrs: Record<string, MessageAttribute>) {
  if (Object.keys(attrs).length > 10) throw new EngineError("InvalidParameterValue", "Number of message attributes [" + Object.keys(attrs).length + "] exceeds the allowed maximum [10].");
  for (const [name, a] of Object.entries(attrs)) {
    if (!a?.DataType) throw new EngineError("InvalidParameterValue", `The message attribute '${name}' must contain non-empty message attribute type.`);
    if (!/^(String|Number|Binary)(\..+)?$/.test(a.DataType)) throw new EngineError("InvalidParameterValue", `The type of message (user) attribute '${name}' is invalid. You must use only the following supported type prefixes: Binary, Number, String.`);
    if (a.StringValue === undefined || a.StringValue === "") throw new EngineError("InvalidParameterValue", `The message attribute '${name}' must contain non-empty message attribute value for message attribute type '${a.DataType}'.`);
    if (a.DataType.startsWith("Number") && Number.isNaN(Number(a.StringValue))) throw new EngineError("InvalidParameterValue", `Could not cast message attribute '${name}' value to number.`);
  }
}

export interface SendInput {
  body: string;
  delaySeconds?: number;
  attributes?: Record<string, MessageAttribute>;
  /** Who sent it: an account number, or a service such as SNS. */
  senderId?: string;
  deadLetterSourceArn?: string;
}

export async function sendMessage(engine: ServiceHost, q: Resource, input: SendInput): Promise<{ MessageId: string; MD5OfMessageBody: string; MD5OfMessageAttributes?: string }> {
  if (input.body === undefined || input.body === null || input.body === "") {
    throw new EngineError("MissingParameter", "The request must contain the parameter MessageBody.");
  }
  if (/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/u.test(input.body)) {
    throw new EngineError("InvalidMessageContents", "Invalid characters found. Valid unicode characters are #x9 | #xA | #xD | #x20 to #xD7FF | #xE000 to #xFFFD | #x10000 to #x10FFFF");
  }
  const attrs = input.attributes ?? {};
  checkAttributes(attrs);
  const size = Buffer.byteLength(input.body) + Object.entries(attrs).reduce((n, [k, a]) => n + k.length + a.DataType.length + (a.StringValue?.length ?? 0), 0);
  const max = num(q, "maximumMessageSize");
  if (size > max) throw new EngineError("InvalidParameterValue", `One or more parameters are invalid. Reason: Message must be shorter than ${max} bytes.`);
  const delay = input.delaySeconds ?? num(q, "delaySeconds");
  if (!Number.isInteger(delay) || delay < 0 || delay > 900) throw new EngineError("InvalidParameterValue", `Value ${delay} for parameter DelaySeconds is invalid. Reason: DelaySeconds must be >= 0 and <= 900.`);

  const now = engine.now().getTime();
  const fresh = await load(engine, q);
  const msgs = retained(fresh, messagesOf(fresh), now);
  if (msgs.length >= MAX_MESSAGES) throw new EngineError("OverLimit", `CloudLab keeps at most ${MAX_MESSAGES} messages in a queue. Receive and delete some, or purge the queue.`, 403);
  if (msgs.reduce((n, m) => n + m.body.length, 0) + size > MAX_QUEUE_BYTES) throw new EngineError("OverLimit", "CloudLab keeps at most 4 MB of messages in a queue. Receive and delete some, or purge the queue.", 403);

  const m: StoredMessage = {
    messageId: randomUUID(),
    body: input.body,
    md5: md5(input.body),
    attributes: attrs,
    sentAt: now,
    visibleAt: now + delay * 1000,
    receiveCount: 0,
    senderId: input.senderId ?? accountNumber(q.accountId),
    deadLetterSourceArn: input.deadLetterSourceArn,
  };
  await save(engine, fresh, [...msgs, m], {}, { sent: 1, fromSns: m.senderId === SNS_SENDER ? 1 : 0 });
  await engine.metrics.record(q.accountId, q.region, "AWS/SQS", "NumberOfMessagesSent", { QueueName: q.name }, 1, "Count");
  await engine.metrics.record(q.accountId, q.region, "AWS/SQS", "SentMessageSize", { QueueName: q.name }, size, "Bytes");
  return { MessageId: m.messageId, MD5OfMessageBody: m.md5, ...(Object.keys(attrs).length ? { MD5OfMessageAttributes: md5OfAttributes(attrs) } : {}) };
}

export interface ReceiveInput {
  maxNumberOfMessages?: number;
  visibilityTimeout?: number;
  waitTimeSeconds?: number;
  /** "All" or names such as ApproximateReceiveCount. */
  attributeNames?: string[];
  messageAttributeNames?: string[];
}

function receiveAttributes(m: StoredMessage, names: string[]): Record<string, string> | undefined {
  if (names.length === 0) return undefined;
  const all: Record<string, string> = {
    SenderId: m.senderId,
    ApproximateFirstReceiveTimestamp: String(m.firstReceivedAt ?? ""),
    ApproximateReceiveCount: String(m.receiveCount),
    SentTimestamp: String(m.sentAt),
    ...(m.deadLetterSourceArn ? { DeadLetterQueueSourceArn: m.deadLetterSourceArn } : {}),
  };
  if (names.includes("All")) return all;
  return Object.fromEntries(Object.entries(all).filter(([k]) => names.includes(k)));
}

/** ReceiveMessage. A message received more times than the redrive policy allows moves to the dead-letter queue instead. */
export async function receiveMessages(engine: ServiceHost, q: Resource, input: ReceiveInput = {}): Promise<{ messages: ReceivedMessage[]; movedToDlq: number }> {
  const max = input.maxNumberOfMessages ?? 1;
  if (!Number.isInteger(max) || max < 1 || max > 10) {
    throw new EngineError("InvalidParameterValue", `Value ${max} for parameter MaxNumberOfMessages is invalid. Reason: Must be between 1 and 10, if provided.`);
  }
  const wait = input.waitTimeSeconds;
  if (wait !== undefined && (!Number.isInteger(wait) || wait < 0 || wait > 20)) {
    throw new EngineError("InvalidParameterValue", `Value ${wait} for parameter WaitTimeSeconds is invalid. Reason: Must be >= 0 and <= 20, if provided.`);
  }
  const vt = input.visibilityTimeout ?? num(q, "visibilityTimeout");
  if (!Number.isInteger(vt) || vt < 0 || vt > 43200) throw new EngineError("InvalidParameterValue", `Value ${vt} for parameter VisibilityTimeout is invalid. Reason: Must be >= 0 and <= 43200, if provided.`);

  const now = engine.now().getTime();
  const fresh = await load(engine, q);
  let msgs = retained(fresh, messagesOf(fresh), now);
  const dlqUrl = fresh.config.deadLetterQueue ? String(fresh.config.deadLetterQueue) : null;
  const maxReceives = Number(fresh.config.maxReceiveCount ?? 10);
  const dlq = dlqUrl ? await engine.get(q.accountId, dlqUrl).catch(() => null) : null;

  const out: ReceivedMessage[] = [];
  const toDlq: StoredMessage[] = [];
  // Standard queues don't promise order; CloudLab hands out the oldest ready messages first.
  for (const m of [...msgs].sort((a, b) => a.sentAt - b.sentAt)) {
    if (out.length >= max) break;
    if (m.visibleAt > now) continue;
    if (dlq && m.receiveCount >= maxReceives) {
      toDlq.push(m);
      continue;
    }
    m.receiveCount += 1;
    m.firstReceivedAt ??= now;
    m.receiptHandle = randomBytes(48).toString("base64url");
    m.visibleAt = now + vt * 1000;
    const wanted = input.messageAttributeNames ?? [];
    const attrs = Object.fromEntries(Object.entries(m.attributes).filter(([k]) => wanted.includes("All") || wanted.includes(".*") || wanted.includes(k)));
    out.push({
      MessageId: m.messageId,
      ReceiptHandle: m.receiptHandle,
      MD5OfBody: m.md5,
      Body: m.body,
      ...(input.attributeNames?.length ? { Attributes: receiveAttributes(m, input.attributeNames) } : {}),
      ...(Object.keys(attrs).length
        ? { MD5OfMessageAttributes: md5OfAttributes(attrs), MessageAttributes: Object.fromEntries(Object.entries(attrs).map(([k, a]) => [k, { StringValue: a.StringValue, DataType: a.DataType }])) }
        : {}),
    });
  }
  if (toDlq.length) msgs = msgs.filter((m) => !toDlq.includes(m));
  const again = out.filter((o) => (msgs.find((m) => m.messageId === o.MessageId)?.receiveCount ?? 0) > 1).length;
  await save(engine, fresh, msgs, {}, { received: out.length, redelivered: again, movedToDlq: toDlq.length });
  for (const m of toDlq) {
    await sendMessage(engine, dlq!, { body: m.body, attributes: m.attributes, senderId: m.senderId, deadLetterSourceArn: arnOf(fresh), delaySeconds: 0 }).catch(() => undefined);
  }
  const dims = { QueueName: q.name };
  if (out.length) await engine.metrics.record(q.accountId, q.region, "AWS/SQS", "NumberOfMessagesReceived", dims, out.length, "Count");
  else await engine.metrics.record(q.accountId, q.region, "AWS/SQS", "NumberOfEmptyReceives", dims, 1, "Count");
  return { messages: out, movedToDlq: toDlq.length };
}

function byHandle(msgs: StoredMessage[], handle: string): StoredMessage | undefined {
  if (!handle || handle.length < 20) throw new EngineError("ReceiptHandleIsInvalid", `The input receipt handle "${handle}" is not a valid receipt handle.`);
  return msgs.find((m) => m.receiptHandle === handle);
}

/** DeleteMessage. A stale handle for a message already gone succeeds quietly, as in SQS. */
export async function deleteMessage(engine: ServiceHost, q: Resource, handle: string): Promise<void> {
  const fresh = await load(engine, q);
  const msgs = messagesOf(fresh);
  const m = byHandle(msgs, handle);
  if (!m) return;
  await save(engine, fresh, msgs.filter((x) => x !== m), {}, { deleted: 1 });
  await engine.metrics.record(q.accountId, q.region, "AWS/SQS", "NumberOfMessagesDeleted", { QueueName: q.name }, 1, "Count");
}

/** ChangeMessageVisibility: more time to finish, or 0 to give it back straight away. */
export async function changeVisibility(engine: ServiceHost, q: Resource, handle: string, seconds: number): Promise<void> {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 43200) {
    throw new EngineError("InvalidParameterValue", `Value ${seconds} for parameter VisibilityTimeout is invalid. Reason: Must be >= 0 and <= 43200, if provided.`);
  }
  const now = engine.now().getTime();
  const fresh = await load(engine, q);
  const msgs = messagesOf(fresh);
  const m = byHandle(msgs, handle);
  if (!m || m.visibleAt <= now) {
    throw new EngineError("MessageNotInflight", "Value " + handle + " for parameter ReceiptHandle is invalid. Reason: Message does not exist or is not available for visibility timeout change.");
  }
  m.visibleAt = now + seconds * 1000;
  await save(engine, fresh, msgs);
}

/** PurgeQueue: deletes every message. Once a minute at most. */
export async function purgeQueue(engine: ServiceHost, q: Resource): Promise<void> {
  const now = engine.now().getTime();
  const fresh = await load(engine, q);
  const last = Number(fresh.attributes.lastPurgeAt ?? 0);
  if (now - last < PURGE_COOLDOWN_MS) {
    throw new EngineError("AWS.SimpleQueueService.PurgeQueueInProgress", `Only one PurgeQueue operation on ${q.name} is allowed every 60 seconds.`, 403);
  }
  await save(engine, fresh, [], { lastPurgeAt: now });
}

// ---------- access policy ----------

interface PolicyStatement {
  Effect?: string;
  Principal?: string | { Service?: string | string[]; AWS?: string | string[] };
  Action?: string | string[];
  Resource?: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

const arr = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const globMatch = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i").test(value);

function conditionHolds(cond: PolicyStatement["Condition"], sourceArn: string): boolean {
  if (!cond) return true;
  for (const [op, entries] of Object.entries(cond)) {
    for (const [key, val] of Object.entries(entries)) {
      if (key.toLowerCase() !== "aws:sourcearn") return false; // conditions CloudLab doesn't know about don't match
      const values = arr(val);
      const ok = /^(ArnEquals|StringEquals)$/i.test(op)
        ? values.some((v) => v === sourceArn)
        : /^(ArnLike|StringLike)$/i.test(op)
          ? values.some((v) => globMatch(v, sourceArn))
          : false;
      if (!ok) return false;
    }
  }
  return true;
}

/** Whether a queue's access policy lets a service (e.g. sns.amazonaws.com) send to it on behalf of `sourceArn`. */
export function policyAllowsService(q: Resource, service: string, action: string, sourceArn: string): boolean {
  if (!q.config.policy) return false;
  let doc: { Statement?: PolicyStatement | PolicyStatement[] };
  try {
    doc = JSON.parse(String(q.config.policy));
  } catch {
    return false;
  }
  const arn = arnOf(q);
  const applies = (s: PolicyStatement) => {
    const p = s.Principal;
    const principalOk = p === "*" || (typeof p === "object" && (arr(p.Service).includes(service) || arr(p.AWS).includes("*")));
    const actionOk = arr(s.Action).some((a) => globMatch(a, action));
    const resourceOk = s.Resource === undefined || arr(s.Resource).some((r) => globMatch(r, arn));
    return principalOk && actionOk && resourceOk && conditionHolds(s.Condition, sourceArn);
  };
  const statements = arr(doc.Statement);
  if (statements.some((s) => s.Effect === "Deny" && applies(s))) return false;
  return statements.some((s) => s.Effect === "Allow" && applies(s));
}

/** The policy statement the SQS console adds when you subscribe a queue to a topic. */
export function snsSendStatement(q: Resource, topicArn: string) {
  return {
    Sid: `topic-subscription-${topicArn}`,
    Effect: "Allow",
    Principal: { Service: "sns.amazonaws.com" },
    Action: "sqs:SendMessage",
    Resource: arnOf(q),
    Condition: { ArnLike: { "aws:SourceArn": topicArn } },
  };
}

/** Adds a statement to a queue's policy (creating the policy if needed). */
export function withStatement(q: Resource, statement: Record<string, unknown>): string {
  let doc: { Version?: string; Id?: string; Statement?: unknown } = {};
  try {
    doc = q.config.policy ? JSON.parse(String(q.config.policy)) : {};
  } catch {
    doc = {};
  }
  const existing = arr(doc.Statement as Record<string, unknown> | Record<string, unknown>[] | undefined).filter((s) => s.Sid !== statement.Sid);
  return JSON.stringify({ Version: doc.Version ?? "2012-10-17", Id: doc.Id ?? "__default_policy_ID", Statement: [...existing, statement] }, null, 2);
}
