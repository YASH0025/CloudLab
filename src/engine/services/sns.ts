import { randomBytes, randomUUID } from "node:crypto";
import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import type { Resource, ResourceTypeDef, ServiceDef } from "../types";

/**
 * SNS: topics and their subscriptions. Publishing (sns/publish.ts) fans a
 * message out to every confirmed subscription whose filter policy matches.
 * Email subscriptions start as "pending-confirmation" and land a confirmation
 * email in a simulated inbox; Lambda (and SQS) subscriptions are confirmed
 * straight away, as on AWS.
 */

export const PROTOCOLS = ["email", "email-json", "lambda"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** Recent deliveries kept on a topic, and emails kept in a subscription's inbox. */
export const KEEP_DELIVERIES = 50;
export const KEEP_INBOX = 25;

export const topicArn = (region: string, accountId: string, name: string) => `arn:aws:sns:${region}:${accountNumber(accountId)}:${name}`;
export const topicNameOf = (arn: string) => arn.split(":").pop() ?? arn;

const TOPIC_ARN = /^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/;
const SUB_ARN = /^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}:[0-9a-f-]{36}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LAMBDA_ARN = /^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]{1,64}(:[A-Za-z0-9$_-]+)?$/;

export const invalid = (what: string) => new EngineError("InvalidParameter", `Invalid parameter: ${what}`);

/** The function an endpoint ARN names (a version or alias suffix is ignored). */
export const functionArnOf = (endpoint: string) => endpoint.split(":").slice(0, 7).join(":");

// ---------- filter policies ----------

type Condition = string | number | boolean | null | Record<string, unknown>;

const NUMERIC_OPS = ["=", "<", "<=", ">", ">="];

/** Checks a filter policy's shape, throwing the error SNS gives for a bad one. */
export function checkFilterPolicy(text: string): Record<string, Condition[]> {
  const bad = (why: string) => invalid(`FilterPolicy: ${why}`);
  let policy: unknown;
  try {
    policy = JSON.parse(text);
  } catch {
    throw bad("failed to parse JSON.");
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw bad("Filter policy must be a JSON object");
  const keys = Object.keys(policy);
  if (keys.length === 0) throw bad("Filter policy can not be empty");
  if (keys.length > 5) throw bad("Filter policy can not have more than 5 keys");
  let combinations = 1;
  for (const [key, value] of Object.entries(policy as Record<string, unknown>)) {
    if (!Array.isArray(value)) throw bad(`"${key}" must be an object or an array`);
    if (value.length === 0) throw bad(`Empty arrays are not allowed`);
    combinations *= value.length;
    for (const c of value as Condition[]) {
      if (c === null || typeof c !== "object") continue;
      const [op, arg] = Object.entries(c)[0] ?? [];
      if (Object.keys(c).length !== 1) throw bad(`Unrecognized match type in "${key}"`);
      if (op === "prefix" || op === "suffix" || op === "equals-ignore-case") {
        if (typeof arg !== "string") throw bad(`${op} match pattern must be a string`);
      } else if (op === "exists") {
        if (typeof arg !== "boolean") throw bad("exists match pattern must be either true or false.");
      } else if (op === "anything-but") {
        const ok = typeof arg === "string" || typeof arg === "number" || (Array.isArray(arg) && arg.length > 0) || (arg && typeof arg === "object" && "prefix" in arg);
        if (!ok) throw bad("Value of anything-but must be an array or single string/number value.");
      } else if (op === "numeric") {
        if (!Array.isArray(arg) || arg.length === 0 || arg.length > 4 || arg.length % 2 !== 0) throw bad("Value of numeric must be an array.");
        for (let i = 0; i < arg.length; i += 2) {
          if (!NUMERIC_OPS.includes(String(arg[i]))) throw bad(`Unrecognized numeric range operator: ${arg[i]}`);
          if (typeof arg[i + 1] !== "number") throw bad(`Value of ${arg[i]} must be numeric`);
        }
      } else {
        throw bad(`Unrecognized match type ${op}`);
      }
    }
  }
  if (combinations > 150) throw bad("Filter policy is too complex");
  return policy as Record<string, Condition[]>;
}

export interface MessageAttribute {
  DataType: string;
  StringValue?: string;
}

function matchOne(c: Condition, value: string | number | undefined, present: boolean): boolean {
  if (c === null || typeof c !== "object") return present && value !== undefined && String(value) === String(c);
  const [op, arg] = Object.entries(c)[0];
  if (op === "exists") return arg === present;
  if (!present || value === undefined) return false;
  const s = String(value);
  if (op === "prefix") return s.startsWith(String(arg));
  if (op === "suffix") return s.endsWith(String(arg));
  if (op === "equals-ignore-case") return s.toLowerCase() === String(arg).toLowerCase();
  if (op === "anything-but") {
    if (Array.isArray(arg)) return !arg.map(String).includes(s);
    if (arg && typeof arg === "object") return !s.startsWith(String((arg as { prefix: string }).prefix));
    return s !== String(arg);
  }
  if (op === "numeric") {
    const n = Number(value);
    if (Number.isNaN(n)) return false;
    const a = arg as (string | number)[];
    for (let i = 0; i < a.length; i += 2) {
      const t = Number(a[i + 1]);
      const ok = { "=": n === t, "<": n < t, "<=": n <= t, ">": n > t, ">=": n >= t }[String(a[i])];
      if (!ok) return false;
    }
    return true;
  }
  return false;
}

/**
 * Whether a message's attributes pass a filter policy: every key must match,
 * and a key matches if any of its conditions does. A String.Array attribute
 * matches if any of its items does.
 */
export function matchesFilter(policy: Record<string, Condition[]>, attributes: Record<string, MessageAttribute>): { match: boolean; failedKey?: string } {
  for (const [key, conditions] of Object.entries(policy)) {
    const attr = attributes[key];
    let values: (string | number | undefined)[] = [undefined];
    if (attr) {
      if (attr.DataType === "String.Array") {
        try {
          const arr = JSON.parse(attr.StringValue ?? "[]");
          values = Array.isArray(arr) ? arr : [attr.StringValue];
        } catch {
          values = [attr.StringValue];
        }
      } else if (attr.DataType.startsWith("Number")) values = [Number(attr.StringValue)];
      else values = [attr.StringValue];
    }
    const ok = conditions.some((c) => values.some((v) => matchOne(c, v, !!attr)));
    if (!ok) return { match: false, failedKey: key };
  }
  return { match: true };
}

// ---------- types ----------

const topic: ResourceTypeDef = {
  service: "sns",
  type: "topic",
  label: "Topic",
  pluralLabel: "Topics",
  description:
    "A channel you publish messages to. Everyone subscribed (email addresses, Lambda functions, queues) gets a copy, so the sender doesn't need to know who's listening.",
  idPrefix: "topic",
  makeId: ({ name, region, accountId }) => topicArn(region, accountId, name),
  idPattern: TOPIC_ARN,
  notFoundCode: "NotFound",
  notFoundMessage: () => "Topic does not exist",
  notFoundByNameMessage: () => "Topic does not exist",
  malformedCode: "InvalidParameter",
  malformedMessage: () => "Invalid parameter: TopicArn",
  apiNoun: "topic",
  panelAttributes: ["deliveries", "published"],
  fields: [
    {
      key: "name",
      label: "Name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 256,
      pattern: "^[A-Za-z0-9_-]+$",
      patternMessage: "Letters, numbers, hyphens and underscores only (up to 256).",
      placeholder: "site-alerts",
      param: "Name",
      description: "Part of the topic's ARN, which is what publishers and subscribers use.",
    },
    {
      key: "displayName",
      label: "Display name",
      type: "string",
      maxLength: 100,
      placeholder: "MyShop alerts",
      param: "DisplayName",
      description: "Shown as the sender of emails (and SMS). Optional.",
    },
  ],
  columns: [
    { label: "Display name", path: "config.displayName" },
  ],
  iam: {
    create: "sns:CreateTopic",
    read: "sns:GetTopicAttributes",
    update: "sns:SetTopicAttributes",
    delete: "sns:DeleteTopic",
    arn: (r) => r.id,
  },
  invalidValue({ field, value }) {
    if (field.key === "name") {
      if (typeof value === "string" && value.endsWith(".fifo")) {
        return invalid("Topic Name (CloudLab simulates standard topics; FIFO topics, ending in .fifo, aren't available yet)");
      }
      return invalid("Topic Name");
    }
    if (field.key === "displayName") return invalid("DisplayName");
    return undefined;
  },
  async validate({ config, existing, ctx }) {
    if (!existing && (await ctx.list("sns", "topic")).some((t) => t.name === config.name)) {
      throw invalid("Topic already exists with different attributes");
    }
  },
  async derive({ existing }) {
    return { ...(existing?.attributes ?? {}) };
  },
};

const subscription: ResourceTypeDef = {
  service: "sns",
  type: "subscription",
  label: "Subscription",
  pluralLabel: "Subscriptions",
  description:
    "Who gets a topic's messages, and how: an email address, a Lambda function or a queue. Email subscriptions must be confirmed from the inbox before they receive anything. A filter policy picks which messages it wants.",
  idPrefix: "sub",
  makeId: ({ config }) => `${config.topicArn}:${randomUUID()}`,
  idPattern: SUB_ARN,
  notFoundCode: "NotFound",
  notFoundMessage: () => "Subscription does not exist",
  malformedCode: "InvalidParameter",
  malformedMessage: () => "Invalid parameter: SubscriptionArn",
  apiNoun: "subscription",
  panelAttributes: ["inbox", "token"],
  privateAttributes: ["token"],
  fields: [
    {
      key: "topicArn",
      label: "Topic",
      type: "ref",
      ref: { service: "sns", type: "topic" },
      required: true,
      immutable: true,
      param: "TopicArn",
    },
    {
      key: "protocol",
      label: "Protocol",
      type: "enum",
      required: true,
      immutable: true,
      default: "email",
      param: "Protocol",
      options: [
        { value: "email", label: "Email", hint: "A readable email per message" },
        { value: "email-json", label: "Email-JSON", hint: "The full SNS message as JSON, for programs reading a mailbox" },
        { value: "lambda", label: "AWS Lambda", hint: "Runs a function with each message" },
      ],
    },
    {
      key: "endpoint",
      label: "Endpoint",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 512,
      param: "Endpoint",
      placeholder: "you@example.com  or  arn:aws:lambda:us-east-1:123456789012:function:hello",
      description: "For email: the address. For Lambda: the function's ARN (on its page). In CloudLab no real email is sent: it lands in the subscription's inbox.",
    },
    {
      key: "filterPolicy",
      label: "Filter policy",
      type: "json",
      param: "FilterPolicy",
      placeholder: '{ "type": ["order"], "amount": [{ "numeric": [">", 100] }] }',
      description:
        "Optional. Only messages whose attributes match are delivered: every key must match, and any value listed for a key will do. Without a policy, every message is delivered.",
    },
  ],
  columns: [
    { label: "Protocol", path: "config.protocol" },
    { label: "Topic", path: "attributes.topicName" },
  ],
  lifecycle: {
    create: { state: "pending-confirmation" },
    actions: {
      confirm: { label: "Confirm", from: ["pending-confirmation"], to: "confirmed", pastTense: "confirmed", hidden: true },
    },
  },
  iam: {
    create: "sns:Subscribe",
    read: "sns:GetSubscriptionAttributes",
    update: "sns:SetSubscriptionAttributes",
    delete: "sns:Unsubscribe",
    arn: (r) => r.id,
  },
  invalidValue({ field }) {
    if (field.key === "protocol") return invalid("Invalid protocol type (CloudLab supports email, email-json and lambda)");
    if (field.key === "endpoint") return invalid("Endpoint");
    if (field.key === "filterPolicy") return invalid("FilterPolicy: failed to parse JSON.");
    return undefined;
  },
  async normalize({ config }) {
    return { ...config, endpoint: String(config.endpoint ?? "").trim(), name: `${config.protocol}: ${String(config.endpoint ?? "").trim()}` };
  },
  async validate({ config, existing, ctx }) {
    const endpoint = String(config.endpoint);
    if (config.protocol === "email" || config.protocol === "email-json") {
      if (!EMAIL.test(endpoint)) throw invalid("Email address");
    } else if (config.protocol === "lambda") {
      if (!LAMBDA_ARN.test(endpoint)) throw invalid("Lambda endpoint ARN");
    }
    if (config.filterPolicy) checkFilterPolicy(String(config.filterPolicy));
    if (!existing) {
      // Subscribing the same endpoint twice gives back the existing subscription (the CLI does that); the console says so.
      const same = (await ctx.list("sns", "subscription")).find(
        (s) => s.config.topicArn === config.topicArn && s.config.protocol === config.protocol && s.config.endpoint === endpoint,
      );
      if (same) throw invalid(`This endpoint is already subscribed to the topic (${same.id}).`);
      const topicSubs = (await ctx.list("sns", "subscription")).filter((s) => s.config.topicArn === config.topicArn);
      if (topicSubs.length >= 100) throw new EngineError("SubscriptionLimitExceeded", "CloudLab allows 100 subscriptions per topic.");
    }
  },
  async derive({ config, existing }) {
    return {
      ...(existing?.attributes ?? {}),
      topicName: topicNameOf(String(config.topicArn)),
      token: existing?.attributes.token ?? randomBytes(32).toString("hex"),
    };
  },
  async afterCreate({ resource, system }) {
    // Deleted with its topic, as on AWS.
    await system.setAttributes(resource.id, { system: { ownedBy: String(resource.config.topicArn) } });
    if (resource.config.protocol === "lambda") {
      await system.runAction(resource.id, "confirm");
      return;
    }
    const topic = await system.get(String(resource.config.topicArn));
    await system.setAttributes(resource.id, { inbox: [confirmationEmail(resource, topic)] });
  },
};

// ---------- emails ----------

export interface InboxEmail {
  id: string;
  at: string;
  from: string;
  subject: string;
  body: string;
  kind: "confirmation" | "notification";
  messageId?: string;
}

export const senderOf = (topic: Resource | null) => `${(topic?.config.displayName as string | undefined) || "AWS Notifications"} <no-reply@sns.amazonaws.com>`;

function confirmationEmail(sub: Resource, topic: Resource | null): InboxEmail {
  const name = topicNameOf(String(sub.config.topicArn));
  return {
    id: randomUUID(),
    at: sub.createdAt,
    from: senderOf(topic),
    subject: "AWS Notification - Subscription Confirmation",
    body: [
      `You have chosen to subscribe to the topic:`,
      String(sub.config.topicArn),
      ``,
      `To confirm this subscription, click or visit the link below (If this was in error no action is necessary):`,
      `Confirm subscription`,
      ``,
      `Please do not reply directly to this email. If you wish to remove yourself from receiving all future SNS subscription confirmation requests please send an email to sns-opt-out`,
    ].join("\n"),
    kind: "confirmation",
    messageId: name,
  };
}

export const snsService: ServiceDef = {
  id: "sns",
  label: "Simple Notification Service",
  modelledOn: "Amazon SNS",
  description: "Topics that send each message to every subscriber: email alerts, Lambda functions, queues.",
  category: "Integration",
  types: [topic, subscription],
};
