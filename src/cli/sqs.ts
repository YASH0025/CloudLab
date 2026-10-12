import { EngineError } from "@/engine/errors";
import { attributesToConfig, checkDeadLetterQueue, KNOWN_ATTRIBUTES, queueAttributes } from "@/engine/sqs/attributes";
import { changeVisibility, deleteMessage, purgeQueue, receiveMessages, sendMessage } from "@/engine/sqs/queue";
import { QUEUE_SETTINGS } from "@/engine/services/sqs";
import type { Args, CliContext, Command } from "./commands";
import { UsageError } from "./parse";
import { messageAttributesArg, textArg } from "./sns";

/**
 * `aws sqs`: queues and their messages. Queues are named by URL, as in the
 * real API; ARNs appear in policies, redrive policies and SNS subscriptions.
 */

const cmd = (c: Command) => c;

const listQueues = (ctx: CliContext) => ctx.engine.list(ctx.accountId, { service: "sqs", type: "queue", region: ctx.region });
const byUrl = (ctx: CliContext, url: string) => ctx.engine.getTyped(ctx.accountId, url.trim(), "sqs", "queue", ctx.region);

/** --attributes VisibilityTimeout=60,DelaySeconds=5 or a JSON object (needed for Policy and RedrivePolicy). */
function attributesArg(ctx: CliContext, args: Args): Record<string, string> {
  const raw = args.raw("attributes").join(" ").trim();
  if (!raw) return {};
  const text = textArg(ctx, raw);
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
    } catch {
      throw new UsageError(`Error parsing parameter '--attributes': Invalid JSON: ${text}`);
    }
  }
  const out: Record<string, string> = {};
  for (const part of text.split(new RegExp(`,(?=(?:${KNOWN_ATTRIBUTES.join("|")})=)`))) {
    const eq = part.indexOf("=");
    if (eq === -1) throw new UsageError(`Error parsing parameter '--attributes': Expected: '=', received: end of input for input: ${part}`);
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** The DLQ must exist; SQS checks when the redrive policy is set. */
async function checkDlq(ctx: CliContext, config: Record<string, unknown>) {
  await checkDeadLetterQueue(config, async () => (await listQueues(ctx)).map((q) => q.id));
}

const intArg = (args: Args, name: string): number | undefined => {
  const v = args.one(name);
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new UsageError(`argument --${name}: invalid int value: '${v}'`);
  return Number(v);
};

export const SQS_COMMANDS: Command[] = [
  cmd({
    service: "sqs",
    operation: "create-queue",
    apiName: "CreateQueue",
    summary: "Create a queue (or get the URL of the identical one that exists)",
    usage: "--queue-name <name> [--attributes VisibilityTimeout=60,DelaySeconds=0 | '{\"RedrivePolicy\":\"{…}\"}']",
    mutates: true,
    async run(args, ctx) {
      const name = args.required("queue-name");
      const config = attributesToConfig(attributesArg(ctx, args));
      await checkDlq(ctx, config);
      const existing = (await listQueues(ctx)).find((q) => q.name === name);
      if (existing) {
        // Same name and same attributes: the existing queue's URL. Anything different: an error naming the attribute.
        for (const [key, value] of Object.entries(config)) {
          if (JSON.stringify(existing.config[key] ?? null) !== JSON.stringify(value ?? null)) {
            const attr = (QUEUE_SETTINGS as Record<string, { attr: string }>)[key]?.attr ?? (key === "policy" ? "Policy" : "RedrivePolicy");
            throw new EngineError("QueueAlreadyExists", `A queue already exists with the same name and a different value for attribute ${attr}`);
          }
        }
        return { QueueUrl: existing.id };
      }
      const q = await ctx.engine.create(ctx.accountId, { service: "sqs", type: "queue", region: ctx.region, config: { name, ...config } });
      return { QueueUrl: q.id };
    },
  }),
  cmd({
    service: "sqs",
    operation: "list-queues",
    apiName: "ListQueues",
    summary: "List queue URLs",
    usage: "[--queue-name-prefix <prefix>]",
    mutates: false,
    async run(args, ctx) {
      const prefix = args.one("queue-name-prefix") ?? "";
      const urls = (await listQueues(ctx)).filter((q) => q.name.startsWith(prefix)).map((q) => q.id).sort();
      return urls.length ? { QueueUrls: urls } : undefined;
    },
  }),
  cmd({
    service: "sqs",
    operation: "get-queue-url",
    apiName: "GetQueueUrl",
    summary: "Find a queue's URL from its name",
    usage: "--queue-name <name>",
    mutates: false,
    async run(args, ctx) {
      const name = args.required("queue-name");
      const q = (await listQueues(ctx)).find((x) => x.name === name);
      if (!q) throw new EngineError("AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.");
      return { QueueUrl: q.id };
    },
  }),
  cmd({
    service: "sqs",
    operation: "delete-queue",
    apiName: "DeleteQueue",
    summary: "Delete a queue and every message in it",
    usage: "--queue-url <url>",
    mutates: true,
    async run(args, ctx) {
      const q = await byUrl(ctx, args.required("queue-url"));
      await ctx.engine.remove(ctx.accountId, q.id);
    },
  }),
  cmd({
    service: "sqs",
    operation: "get-queue-attributes",
    apiName: "GetQueueAttributes",
    summary: "Show a queue's settings and message counts",
    usage: "--queue-url <url> --attribute-names All | <name> ...",
    mutates: false,
    async run(args, ctx) {
      const q = await byUrl(ctx, args.required("queue-url"));
      const names = args.list("attribute-names");
      if (names.length === 0) return undefined;
      const all = queueAttributes(q, ctx.engine.now().getTime());
      if (names.includes("All")) return { Attributes: all };
      for (const n of names) if (!KNOWN_ATTRIBUTES.includes(n) && n !== "RedriveAllowPolicy") throw new EngineError("InvalidAttributeName", `Unknown Attribute ${n}.`);
      const picked = Object.fromEntries(names.filter((n) => n in all).map((n) => [n, all[n]]));
      return Object.keys(picked).length ? { Attributes: picked } : undefined;
    },
  }),
  cmd({
    service: "sqs",
    operation: "set-queue-attributes",
    apiName: "SetQueueAttributes",
    summary: "Change settings: VisibilityTimeout, RedrivePolicy, Policy…",
    usage: "--queue-url <url> --attributes VisibilityTimeout=60 | '{\"Policy\":\"{…}\"}'",
    mutates: true,
    async run(args, ctx) {
      const q = await byUrl(ctx, args.required("queue-url"));
      const attrs = attributesArg(ctx, args);
      if (Object.keys(attrs).length === 0) throw new UsageError("the following arguments are required: --attributes");
      const config = attributesToConfig(attrs);
      await checkDlq(ctx, config);
      if (config.deadLetterQueue === q.id) {
        throw new EngineError("InvalidParameterValue", `Value ${attrs.RedrivePolicy} for parameter RedrivePolicy is invalid. Reason: Dead letter target cannot be the queue itself.`);
      }
      await ctx.engine.update(ctx.accountId, q.id, config);
    },
  }),
  cmd({
    service: "sqs",
    operation: "send-message",
    apiName: "SendMessage",
    summary: "Put a message in a queue",
    usage: "--queue-url <url> --message-body <text|file://msg.json> [--delay-seconds <0-900>] [--message-attributes <name>={DataType=String,StringValue=<v>}]",
    mutates: true,
    async run(args, ctx) {
      const q = await byUrl(ctx, args.required("queue-url"));
      const body = args.one("message-body");
      if (body === undefined) throw new UsageError("the following arguments are required: --message-body");
      return sendMessage(ctx.engine, q, { body: textArg(ctx, body), delaySeconds: intArg(args, "delay-seconds"), attributes: messageAttributesArg(ctx, args) });
    },
  }),
  cmd({
    service: "sqs",
    operation: "receive-message",
    apiName: "ReceiveMessage",
    summary: "Take up to 10 messages (they stay hidden until deleted or the visibility timeout ends)",
    usage: "--queue-url <url> [--max-number-of-messages <1-10>] [--visibility-timeout <s>] [--wait-time-seconds <0-20>] [--attribute-names All] [--message-system-attribute-names All] [--message-attribute-names All]",
    mutates: true,
    async run(args, ctx) {
      const q = await byUrl(ctx, args.required("queue-url"));
      const r = await receiveMessages(ctx.engine, q, {
        maxNumberOfMessages: intArg(args, "max-number-of-messages"),
        visibilityTimeout: intArg(args, "visibility-timeout"),
        waitTimeSeconds: intArg(args, "wait-time-seconds"),
        attributeNames: [...args.list("attribute-names"), ...args.list("message-system-attribute-names")],
        messageAttributeNames: args.list("message-attribute-names"),
      });
      // Like the real CLI: nothing at all is printed when the queue had nothing to give.
      return r.messages.length ? { Messages: r.messages } : undefined;
    },
  }),
  cmd({
    service: "sqs",
    operation: "delete-message",
    apiName: "DeleteMessage",
    summary: "Delete a message you've finished with, using its receipt handle",
    usage: "--queue-url <url> --receipt-handle <handle>",
    mutates: true,
    async run(args, ctx) {
      const q = await byUrl(ctx, args.required("queue-url"));
      await deleteMessage(ctx.engine, q, args.required("receipt-handle"));
    },
  }),
  cmd({
    service: "sqs",
    operation: "change-message-visibility",
    apiName: "ChangeMessageVisibility",
    summary: "Ask for more time on a message (or 0 to give it back now)",
    usage: "--queue-url <url> --receipt-handle <handle> --visibility-timeout <seconds>",
    mutates: true,
    async run(args, ctx) {
      const q = await byUrl(ctx, args.required("queue-url"));
      const seconds = intArg(args, "visibility-timeout");
      if (seconds === undefined) throw new UsageError("the following arguments are required: --visibility-timeout");
      await changeVisibility(ctx.engine, q, args.required("receipt-handle"), seconds);
    },
  }),
  cmd({
    service: "sqs",
    operation: "purge-queue",
    apiName: "PurgeQueue",
    summary: "Delete every message in the queue (once a minute at most)",
    usage: "--queue-url <url>",
    mutates: true,
    async run(args, ctx) {
      const q = await byUrl(ctx, args.required("queue-url"));
      await purgeQueue(ctx.engine, q);
    },
  }),
];
