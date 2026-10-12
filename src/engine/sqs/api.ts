import { EngineError } from "../errors";
import type { ServiceHost } from "../host";
import type { MessageAttribute } from "../services/sns";
import type { Resource } from "../types";
import { attributesToConfig, checkDeadLetterQueue, KNOWN_ATTRIBUTES, queueAttributes } from "./attributes";
import { changeVisibility, deleteMessage, purgeQueue, receiveMessages, sendMessage, type StoredMessage } from "./queue";

/**
 * SQS's own API (the JSON protocol current AWS SDKs and the AWS CLI speak:
 * POST / with X-Amz-Target: AmazonSQS.<Operation>). Requests, responses and
 * errors are AWS's; the work is done by the same queue code as the console.
 *
 * ReceiveMessage long-polls for real: with WaitTimeSeconds (or the queue's
 * ReceiveMessageWaitTimeSeconds) and nothing to receive, it waits until a message
 * is sent or becomes visible, instead of answering empty at once, so a worker
 * looping on ReceiveMessage costs nothing while the queue is quiet.
 */

export interface SqsApiContext {
  host: ServiceHost;
  accountId: string;
  region: string;
  createQueue(config: Record<string, unknown>): Promise<Resource>;
  updateQueue(q: Resource, patch: Record<string, unknown>): Promise<Resource>;
  deleteQueue(q: Resource): Promise<void>;
  /** The URL clients use for a queue (on the agent: http://localhost:4566/<account>/<name>). */
  urlOf(q: Resource): string;
  /** Long polling: who's waiting on which queue. Without it, receives never wait. */
  waiters?: QueueWaiters;
}

/** Receivers waiting on queues. notify() wakes a queue's waiters when a message may be ready. */
export class QueueWaiters {
  private waiting = new Map<string, Set<() => void>>();

  /** Resolves when notified, or at `until` (ms since 1970), whichever comes first. */
  wait(queueId: string, until: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiting.get(queueId) ?? new Set();
      this.waiting.set(queueId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.waiting.delete(queueId);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, until - Date.now()));
      set.add(done);
    });
  }

  notify(queueId: string) {
    for (const done of [...(this.waiting.get(queueId) ?? [])]) done();
  }

  /** How many receives are waiting (for tests and the console). */
  count(queueId?: string) {
    if (queueId) return this.waiting.get(queueId)?.size ?? 0;
    return [...this.waiting.values()].reduce((n, s) => n + s.size, 0);
  }
}

type Body = Record<string, unknown>;

/** SQS's error names in the JSON protocol, for the codes CloudLab's queue code uses (which are the older Query-API codes). */
const JSON_NAMES: Record<string, string> = {
  "AWS.SimpleQueueService.NonExistentQueue": "QueueDoesNotExist",
  QueueAlreadyExists: "QueueNameExists",
  "AWS.SimpleQueueService.PurgeQueueInProgress": "PurgeQueueInProgress",
  "AWS.SimpleQueueService.TooManyEntriesInBatchRequest": "TooManyEntriesInBatchRequest",
  "AWS.SimpleQueueService.EmptyBatchRequest": "EmptyBatchRequest",
  "AWS.SimpleQueueService.BatchEntryIdsNotDistinct": "BatchEntryIdsNotDistinct",
  "AWS.SimpleQueueService.InvalidBatchEntryId": "InvalidBatchEntryId",
  "AWS.SimpleQueueService.UnsupportedOperation": "UnsupportedOperation",
  "AWS.SimpleQueueService.MessageNotInflight": "MessageNotInflight",
};

/** An error's name in the JSON protocol (__type) and in the Query API (the x-amzn-query-error header SDKs also read). */
export function sqsErrorNames(code: string): { type: string; queryCode: string } {
  return { type: JSON_NAMES[code] ?? code, queryCode: code };
}

const nonExistent = () => new EngineError("AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.", 400);
const missing = (param: string) => new EngineError("MissingParameter", `The request must contain the parameter ${param}.`, 400);

const str = (b: Body, param: string) => {
  const v = b[param];
  if (typeof v !== "string" || !v) throw missing(param);
  return v;
};

async function queues(ctx: SqsApiContext) {
  return ctx.host.list(ctx.accountId, { service: "sqs", type: "queue", region: ctx.region });
}

/** A queue by its URL: any URL ending in /<account>/<name> (SDKs pass the one GetQueueUrl gave them). */
async function byUrl(ctx: SqsApiContext, url: string): Promise<Resource> {
  const name = /\/(\d{12})\/([A-Za-z0-9_-]{1,80})\/?$/.exec(url)?.[2];
  const q = name ? (await queues(ctx)).find((x) => x.name === name) : undefined;
  if (!q) throw nonExistent();
  return q;
}

/** Message attributes from the API: String and Number types (Binary isn't kept by CloudLab yet). */
function messageAttributes(raw: unknown): Record<string, MessageAttribute> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, MessageAttribute> = {};
  for (const [name, a] of Object.entries(raw as Record<string, { DataType?: string; StringValue?: string; BinaryValue?: string }>)) {
    if (a?.BinaryValue !== undefined || a?.DataType?.startsWith("Binary")) {
      throw new EngineError("InvalidParameterValue", `The message attribute '${name}' is Binary: CloudLab keeps String and Number message attributes.`);
    }
    out[name] = { DataType: String(a?.DataType ?? ""), StringValue: a?.StringValue };
  }
  return out;
}

/** The earliest time a hidden or delayed message becomes receivable, if any. */
function nextVisible(q: Resource, now: number): number | null {
  const times = ((q.attributes.messages as StoredMessage[] | undefined) ?? []).map((m) => m.visibleAt).filter((t) => t > now);
  return times.length ? Math.min(...times) : null;
}

// ---------- batches ----------

const MAX_BATCH = 10;
const BATCH_ID = /^[A-Za-z0-9_-]{1,80}$/;

function checkBatch<T extends { Id?: string }>(entries: unknown): T[] {
  const list = Array.isArray(entries) ? (entries as T[]) : [];
  if (list.length === 0) throw new EngineError("AWS.SimpleQueueService.EmptyBatchRequest", "There should be at least one SendMessageBatchRequestEntry in the request.", 400);
  if (list.length > MAX_BATCH) throw new EngineError("AWS.SimpleQueueService.TooManyEntriesInBatchRequest", `Maximum number of entries per request are ${MAX_BATCH}. You have sent ${list.length}.`, 400);
  const ids = new Set<string>();
  for (const e of list) {
    if (!e.Id || !BATCH_ID.test(e.Id)) {
      throw new EngineError("AWS.SimpleQueueService.InvalidBatchEntryId", "A batch entry id can only contain alphanumeric characters, hyphens and underscores. It can be at most 80 letters long.", 400);
    }
    if (ids.has(e.Id)) throw new EngineError("AWS.SimpleQueueService.BatchEntryIdsNotDistinct", `Id ${e.Id} repeated.`, 400);
    ids.add(e.Id);
  }
  return list;
}

/** Runs each entry; failures (a bad receipt handle, an invalid body) are reported per entry, as SQS does. */
async function eachEntry<T extends { Id?: string }, R>(entries: T[], run: (e: T) => Promise<R>) {
  const Successful: (R & { Id: string })[] = [];
  const Failed: { Id: string; SenderFault: boolean; Code: string; Message: string }[] = [];
  for (const e of entries) {
    try {
      Successful.push({ Id: e.Id!, ...(await run(e)) });
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      Failed.push({ Id: e.Id!, SenderFault: err.status < 500, Code: sqsErrorNames(err.code).type, Message: err.message });
    }
  }
  return { Successful, Failed };
}

// ---------- operations ----------

type Handler = (ctx: SqsApiContext, body: Body) => Promise<unknown>;

function toConfig(attrs: unknown): Record<string, unknown> {
  const raw = attrs && typeof attrs === "object" ? (attrs as Record<string, unknown>) : {};
  return attributesToConfig(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])));
}

const queueIds = (ctx: SqsApiContext) => async () => (await queues(ctx)).map((q) => q.id);

async function send(ctx: SqsApiContext, q: Resource, e: { MessageBody?: unknown; DelaySeconds?: number; MessageAttributes?: unknown }) {
  if (typeof e.MessageBody !== "string") throw missing("MessageBody");
  const r = await sendMessage(ctx.host, q, { body: e.MessageBody, delaySeconds: e.DelaySeconds, attributes: messageAttributes(e.MessageAttributes) });
  ctx.waiters?.notify(q.id);
  return r;
}

const ops: Record<string, Handler> = {
  async CreateQueue(ctx, body) {
    const name = str(body, "QueueName");
    const config = toConfig(body.Attributes);
    const existing = (await queues(ctx)).find((q) => q.name === name);
    if (existing) {
      // Creating a queue that exists is fine when the attributes match; otherwise it's an error.
      const now = queueAttributes(existing, Date.now());
      for (const [k, v] of Object.entries((body.Attributes as Record<string, string> | undefined) ?? {})) {
        if (now[k] !== undefined && String(now[k]) !== String(v)) {
          throw new EngineError("QueueAlreadyExists", `A queue already exists with the same name and a different value for attribute ${k}`, 400);
        }
      }
      return { QueueUrl: ctx.urlOf(existing) };
    }
    await checkDeadLetterQueue(config, queueIds(ctx));
    const q = await ctx.createQueue(Object.fromEntries(Object.entries({ name, ...config }).filter(([, v]) => v !== undefined)));
    return { QueueUrl: ctx.urlOf(q) };
  },

  async GetQueueUrl(ctx, body) {
    const name = str(body, "QueueName");
    const q = (await queues(ctx)).find((x) => x.name === name);
    if (!q) throw nonExistent();
    return { QueueUrl: ctx.urlOf(q) };
  },

  async ListQueues(ctx, body) {
    const prefix = typeof body.QueueNamePrefix === "string" ? body.QueueNamePrefix : "";
    const max = body.MaxResults === undefined ? 1000 : Number(body.MaxResults);
    if (!Number.isInteger(max) || max < 1 || max > 1000) throw new EngineError("InvalidParameterValue", "Value for parameter MaxResults is invalid. Reason: MaxResults must be an integer between 1 and 1000.", 400);
    const after = typeof body.NextToken === "string" ? Buffer.from(body.NextToken, "base64").toString("utf8") : "";
    const all = (await queues(ctx)).filter((q) => q.name.startsWith(prefix) && q.name > after).sort((a, b) => a.name.localeCompare(b.name));
    const page = all.slice(0, max);
    return {
      ...(page.length ? { QueueUrls: page.map((q) => ctx.urlOf(q)) } : {}),
      ...(body.MaxResults !== undefined && all.length > max ? { NextToken: Buffer.from(page[page.length - 1].name).toString("base64") } : {}),
    };
  },

  async DeleteQueue(ctx, body) {
    const q = await byUrl(ctx, str(body, "QueueUrl"));
    await ctx.deleteQueue(q);
    ctx.waiters?.notify(q.id);
    return {};
  },

  async GetQueueAttributes(ctx, body) {
    const q = await byUrl(ctx, str(body, "QueueUrl"));
    const names = Array.isArray(body.AttributeNames) ? (body.AttributeNames as string[]) : [];
    if (names.length === 0) return {};
    const all = queueAttributes(await ctx.host.get(q.accountId, q.id), Date.now());
    if (names.includes("All")) return { Attributes: all };
    for (const n of names) if (!KNOWN_ATTRIBUTES.includes(n) && n !== "RedriveAllowPolicy") throw new EngineError("InvalidAttributeName", `Unknown Attribute ${n}.`, 400);
    const picked = Object.fromEntries(names.filter((n) => n in all).map((n) => [n, all[n]]));
    return Object.keys(picked).length ? { Attributes: picked } : {};
  },

  async SetQueueAttributes(ctx, body) {
    const q = await byUrl(ctx, str(body, "QueueUrl"));
    const config = toConfig(body.Attributes);
    if (config.deadLetterQueue && config.deadLetterQueue === q.id) {
      throw new EngineError("InvalidParameterValue", "Value for parameter RedrivePolicy is invalid. Reason: Dead letter target cannot be the queue itself.", 400);
    }
    await checkDeadLetterQueue(config, queueIds(ctx));
    await ctx.updateQueue(q, config);
    return {};
  },

  async ListDeadLetterSourceQueues(ctx, body) {
    const q = await byUrl(ctx, str(body, "QueueUrl"));
    return { queueUrls: (await queues(ctx)).filter((x) => x.config.deadLetterQueue === q.id).map((x) => ctx.urlOf(x)) };
  },

  async SendMessage(ctx, body) {
    const q = await byUrl(ctx, str(body, "QueueUrl"));
    return send(ctx, q, body as { MessageBody?: unknown; DelaySeconds?: number; MessageAttributes?: unknown });
  },

  async SendMessageBatch(ctx, body) {
    const q = await byUrl(ctx, str(body, "QueueUrl"));
    const entries = checkBatch<{ Id?: string; MessageBody?: unknown; DelaySeconds?: number; MessageAttributes?: unknown }>(body.Entries);
    return eachEntry(entries, (e) => send(ctx, q, e));
  },

  async ReceiveMessage(ctx, body) {
    const q = await byUrl(ctx, str(body, "QueueUrl"));
    const wait = body.WaitTimeSeconds === undefined ? Number(q.config.receiveMessageWaitTimeSeconds ?? 0) : Number(body.WaitTimeSeconds);
    const input = {
      maxNumberOfMessages: body.MaxNumberOfMessages as number | undefined,
      visibilityTimeout: body.VisibilityTimeout as number | undefined,
      waitTimeSeconds: wait,
      attributeNames: [...((body.AttributeNames as string[] | undefined) ?? []), ...((body.MessageSystemAttributeNames as string[] | undefined) ?? [])],
      messageAttributeNames: (body.MessageAttributeNames as string[] | undefined) ?? [],
    };
    const deadline = Date.now() + wait * 1000;
    for (;;) {
      const r = await receiveMessages(ctx.host, q, input);
      if (r.messages.length || !ctx.waiters || Date.now() >= deadline) return r.messages.length ? { Messages: r.messages } : {};
      // Nothing yet: sleep until a message is sent, a hidden one comes back, or time's up.
      const fresh = await ctx.host.get(q.accountId, q.id).catch(() => null);
      if (!fresh) throw nonExistent();
      const soon = nextVisible(fresh, Date.now());
      await ctx.waiters.wait(q.id, soon === null ? deadline : Math.min(deadline, soon + 5));
    }
  },

  async DeleteMessage(ctx, body) {
    const q = await byUrl(ctx, str(body, "QueueUrl"));
    await deleteMessage(ctx.host, q, str(body, "ReceiptHandle"));
    return {};
  },

  async DeleteMessageBatch(ctx, body) {
    const q = await byUrl(ctx, str(body, "QueueUrl"));
    const entries = checkBatch<{ Id?: string; ReceiptHandle?: string }>(body.Entries);
    return eachEntry(entries, async (e) => {
      await deleteMessage(ctx.host, q, String(e.ReceiptHandle ?? ""));
      return {};
    });
  },

  async ChangeMessageVisibility(ctx, body) {
    const q = await byUrl(ctx, str(body, "QueueUrl"));
    await changeVisibility(ctx.host, q, str(body, "ReceiptHandle"), Number(body.VisibilityTimeout));
    ctx.waiters?.notify(q.id);
    return {};
  },

  async ChangeMessageVisibilityBatch(ctx, body) {
    const q = await byUrl(ctx, str(body, "QueueUrl"));
    const entries = checkBatch<{ Id?: string; ReceiptHandle?: string; VisibilityTimeout?: number }>(body.Entries);
    const r = await eachEntry(entries, async (e) => {
      await changeVisibility(ctx.host, q, String(e.ReceiptHandle ?? ""), Number(e.VisibilityTimeout));
      return {};
    });
    ctx.waiters?.notify(q.id);
    return r;
  },

  async PurgeQueue(ctx, body) {
    const q = await byUrl(ctx, str(body, "QueueUrl"));
    await purgeQueue(ctx.host, q);
    return {};
  },

  async ListQueueTags(ctx, body) {
    await byUrl(ctx, str(body, "QueueUrl"));
    return {};
  },
};

export const SQS_OPERATIONS = Object.keys(ops);

/** Runs one SQS API call: the operation (from X-Amz-Target) and its JSON body. */
export async function sqsApi(operation: string, body: unknown, ctx: SqsApiContext): Promise<unknown> {
  const handler = ops[operation];
  if (!handler) throw new EngineError("AWS.SimpleQueueService.UnsupportedOperation", `CloudLab's SQS doesn't support ${operation || "this operation"} yet.`, 400);
  return handler(ctx, body && typeof body === "object" && !Array.isArray(body) ? (body as Body) : {});
}
