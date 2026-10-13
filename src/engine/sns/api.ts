import { EngineError } from "../errors";
import type { ServiceHost } from "../host";
import { checkFilterPolicy, invalid, PROTOCOLS, type MessageAttribute } from "../services/sns";
import type { Resource } from "../types";
import { publish } from "./publish";

/**
 * SNS's own API. Unlike DynamoDB and SQS, SNS still speaks AWS's Query protocol:
 * form-encoded requests (Action=Publish&TopicArn=…, with lists and maps flattened
 * into names like MessageAttributes.entry.1.Name) and XML responses. Requests,
 * responses and errors are AWS's; the work is the same code as the console.
 */

export interface SnsApiContext {
  host: ServiceHost;
  accountId: string;
  region: string;
  createTopic(config: Record<string, unknown>): Promise<Resource>;
  updateTopic(t: Resource, patch: Record<string, unknown>): Promise<Resource>;
  deleteTopic(t: Resource): Promise<void>;
  subscribe(config: Record<string, unknown>): Promise<Resource>;
  updateSubscription(s: Resource, patch: Record<string, unknown>): Promise<Resource>;
  unsubscribe(s: Resource): Promise<void>;
  confirm(topicArn: string, token: string): Promise<Resource>;
}

// ---------- the Query protocol ----------

export type Params = Map<string, string>;

/** A list flattened as Prefix.1.X, Prefix.2.X…: one Params per element. */
function list(p: Params, prefix: string): Params[] {
  const out: Params[] = [];
  for (let i = 1; ; i++) {
    const head = `${prefix}.${i}.`;
    const entry: Params = new Map([...p].filter(([k]) => k.startsWith(head)).map(([k, v]) => [k.slice(head.length), v]));
    if (entry.size === 0) return out;
    out.push(entry);
  }
}

/** Attributes.entry.N.key / .value → { key: value }. */
const attributeMap = (p: Params, prefix = "Attributes.entry") => Object.fromEntries(list(p, prefix).map((e) => [e.get("key") ?? "", e.get("value") ?? ""]));

/** MessageAttributes.entry.N.Name / .Value.DataType / .Value.StringValue. */
function messageAttributes(p: Params, prefix = "MessageAttributes.entry"): Record<string, MessageAttribute> {
  const out: Record<string, MessageAttribute> = {};
  for (const e of list(p, prefix)) {
    const name = e.get("Name") ?? "";
    if (e.has("Value.BinaryValue")) throw new EngineError("ParameterValueInvalid", `The message attribute '${name}' is Binary: CloudLab keeps String and Number message attributes.`);
    out[name] = { DataType: e.get("Value.DataType") ?? "", StringValue: e.get("Value.StringValue") };
  }
  return out;
}

/** A map in a response: <entry><key/><value/></entry>. */
class XmlMap {
  constructor(readonly entries: Record<string, string>) {}
}

const esc = (s: unknown) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

function toXml(name: string, v: unknown): string {
  if (v === undefined || v === null) return "";
  if (v instanceof XmlMap) return `<${name}>${Object.entries(v.entries).map(([k, x]) => `<entry><key>${esc(k)}</key><value>${esc(x)}</value></entry>`).join("")}</${name}>`;
  if (Array.isArray(v)) return `<${name}>${v.map((x) => toXml("member", x)).join("")}</${name}>`;
  if (typeof v === "object") return `<${name}>${Object.entries(v).map(([k, x]) => toXml(k, x)).join("")}</${name}>`;
  return `<${name}>${esc(v)}</${name}>`;
}

const XMLNS = "http://sns.amazonaws.com/doc/2010-03-31/";

/** An operation's XML response. */
export function snsResponseXml(action: string, result: Record<string, unknown>, requestId: string): string {
  const inner = Object.keys(result).length ? toXml(`${action}Result`, result) : "";
  return `<?xml version="1.0"?>\n<${action}Response xmlns="${XMLNS}">${inner}<ResponseMetadata><RequestId>${requestId}</RequestId></ResponseMetadata></${action}Response>`;
}

/** An error's XML response. */
export function snsErrorXml(code: string, message: string, status: number, requestId: string): string {
  return `<?xml version="1.0"?>\n<ErrorResponse xmlns="${XMLNS}"><Error><Type>${status >= 500 ? "Receiver" : "Sender"}</Type><Code>${esc(code)}</Code><Message>${esc(message)}</Message></Error><RequestId>${requestId}</RequestId></ErrorResponse>`;
}

// ---------- helpers ----------

const notFound = (what: "Topic" | "Subscription") => new EngineError("NotFound", `${what} does not exist`, 404);

function required(p: Params, name: string): string {
  const v = p.get(name);
  if (v === undefined || v === "") throw invalid(name);
  return v;
}

const ownerOf = (arn: string) => arn.split(":")[4] ?? "";

async function topics(ctx: SnsApiContext) {
  return ctx.host.list(ctx.accountId, { service: "sns", type: "topic", region: ctx.region });
}
async function subscriptions(ctx: SnsApiContext) {
  return ctx.host.list(ctx.accountId, { service: "sns", type: "subscription", region: ctx.region });
}
async function topicByArn(ctx: SnsApiContext, arn: string) {
  const t = (await topics(ctx)).find((x) => x.id === arn);
  if (!t) throw notFound("Topic");
  return t;
}
async function subByArn(ctx: SnsApiContext, arn: string) {
  const s = (await subscriptions(ctx)).find((x) => x.id === arn);
  if (!s) throw notFound("Subscription");
  return s;
}

/** The topic policy AWS gives every new topic (anyone in the account may use it). */
function defaultPolicy(t: Resource) {
  const account = ownerOf(t.id);
  return JSON.stringify({
    Version: "2008-10-17",
    Id: "__default_policy_ID",
    Statement: [
      {
        Sid: "__default_statement_ID",
        Effect: "Allow",
        Principal: { AWS: "*" },
        Action: ["SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission", "SNS:RemovePermission", "SNS:DeleteTopic", "SNS:Subscribe", "SNS:ListSubscriptionsByTopic", "SNS:Publish"],
        Resource: t.id,
        Condition: { StringEquals: { "AWS:SourceOwner": account } },
      },
    ],
  });
}

const listedArn = (s: Resource) => (s.state === "confirmed" ? s.id : "PendingConfirmation");
const subMember = (s: Resource) => ({ SubscriptionArn: listedArn(s), Owner: ownerOf(s.id), Protocol: s.config.protocol, Endpoint: s.config.endpoint, TopicArn: s.config.topicArn });

/** Pages of 100, with NextToken, as ListTopics and ListSubscriptions do. */
function page<T>(items: T[], p: Params) {
  const start = Number(p.get("NextToken") ?? 0) || 0;
  const slice = items.slice(start, start + 100);
  return { slice, next: start + 100 < items.length ? String(start + 100) : undefined };
}

/** Subscription attributes as API names, into settings. */
function subscriptionSettings(attrs: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "FilterPolicy") {
      if (v) checkFilterPolicy(v);
      out.filterPolicy = v || undefined;
    } else if (k === "RawMessageDelivery") {
      if (!/^(true|false)$/i.test(v)) throw invalid("RawMessageDelivery: Invalid value [" + v + "]. Must be true or false.");
      out.rawMessageDelivery = v.toLowerCase() === "true";
    } else if (k === "FilterPolicyScope") {
      if (v !== "MessageAttributes") throw invalid("FilterPolicyScope: CloudLab filters on MessageAttributes.");
    } else {
      throw invalid(`AttributeName (CloudLab supports FilterPolicy and RawMessageDelivery)`);
    }
  }
  return out;
}

// ---------- operations ----------

type Handler = (ctx: SnsApiContext, p: Params) => Promise<Record<string, unknown>>;

async function publishOne(ctx: SnsApiContext, topic: Resource, p: Params, attrsPrefix = "MessageAttributes.entry") {
  const message = p.get("Message");
  if (message === undefined) throw invalid("Message");
  const r = await publish(ctx.host, ctx.accountId, topic, {
    message,
    subject: p.get("Subject"),
    messageStructure: p.get("MessageStructure"),
    attributes: messageAttributes(p, attrsPrefix),
  });
  return r.messageId;
}

const ops: Record<string, Handler> = {
  async CreateTopic(ctx, p) {
    const name = required(p, "Name");
    const attrs = attributeMap(p);
    if (attrs.FifoTopic === "true" || name.endsWith(".fifo")) throw invalid("Topic Name (CloudLab simulates standard topics; FIFO topics aren't available yet)");
    const existing = (await topics(ctx)).find((t) => t.name === name);
    if (existing) {
      if (attrs.DisplayName !== undefined && attrs.DisplayName !== (existing.config.displayName ?? "")) throw invalid("Topic already exists with different attributes");
      return { TopicArn: existing.id };
    }
    for (const k of Object.keys(attrs)) if (!["DisplayName", "FifoTopic"].includes(k)) throw invalid(`Attributes Reason: ${k} (CloudLab supports DisplayName)`);
    const t = await ctx.createTopic({ name, ...(attrs.DisplayName ? { displayName: attrs.DisplayName } : {}) });
    return { TopicArn: t.id };
  },

  async ListTopics(ctx, p) {
    const all = (await topics(ctx)).sort((a, b) => a.id.localeCompare(b.id));
    const { slice, next } = page(all, p);
    return { Topics: slice.map((t) => ({ TopicArn: t.id })), ...(next ? { NextToken: next } : {}) };
  },

  async DeleteTopic(ctx, p) {
    const arn = required(p, "TopicArn");
    const t = (await topics(ctx)).find((x) => x.id === arn);
    // Deleting a topic that doesn't exist isn't an error.
    if (t) await ctx.deleteTopic(t);
    return {};
  },

  async GetTopicAttributes(ctx, p) {
    const t = await topicByArn(ctx, required(p, "TopicArn"));
    const subs = (await subscriptions(ctx)).filter((s) => s.config.topicArn === t.id);
    return {
      Attributes: new XmlMap({
        TopicArn: t.id,
        Owner: ownerOf(t.id),
        DisplayName: String(t.config.displayName ?? ""),
        Policy: defaultPolicy(t),
        SubscriptionsConfirmed: String(subs.filter((s) => s.state === "confirmed").length),
        SubscriptionsPending: String(subs.filter((s) => s.state !== "confirmed").length),
        SubscriptionsDeleted: "0",
        EffectiveDeliveryPolicy: JSON.stringify({ http: { defaultHealthyRetryPolicy: { minDelayTarget: 1, maxDelayTarget: 3, numRetries: 2, numMaxDelayRetries: 0, numNoDelayRetries: 0, numMinDelayRetries: 0, backoffFunction: "linear" }, disableSubscriptionOverrides: false } }),
      }),
    };
  },

  async SetTopicAttributes(ctx, p) {
    const t = await topicByArn(ctx, required(p, "TopicArn"));
    const name = required(p, "AttributeName");
    if (name !== "DisplayName") throw invalid(`AttributeName (CloudLab supports DisplayName)`);
    await ctx.updateTopic(t, { displayName: p.get("AttributeValue") ?? "" });
    return {};
  },

  async Subscribe(ctx, p) {
    const topic = await topicByArn(ctx, required(p, "TopicArn"));
    const protocol = required(p, "Protocol").toLowerCase();
    if (!(PROTOCOLS as readonly string[]).includes(protocol)) throw invalid("Invalid protocol type: " + protocol);
    const endpoint = p.get("Endpoint");
    if (!endpoint) throw invalid("Endpoint");
    const settings = subscriptionSettings(attributeMap(p));
    const same = (await subscriptions(ctx)).find((s) => s.config.topicArn === topic.id && s.config.protocol === protocol && s.config.endpoint === endpoint);
    const sub = same ?? (await ctx.subscribe({ topicArn: topic.id, protocol, endpoint, ...settings }));
    const returnArn = (p.get("ReturnSubscriptionArn") ?? "false").toLowerCase() === "true";
    return { SubscriptionArn: sub.state === "confirmed" || returnArn ? sub.id : "pending confirmation" };
  },

  async ConfirmSubscription(ctx, p) {
    const topic = await topicByArn(ctx, required(p, "TopicArn"));
    const sub = await ctx.confirm(topic.id, required(p, "Token"));
    return { SubscriptionArn: sub.id };
  },

  async Unsubscribe(ctx, p) {
    const sub = await subByArn(ctx, required(p, "SubscriptionArn"));
    await ctx.unsubscribe(sub);
    return {};
  },

  async ListSubscriptions(ctx, p) {
    const { slice, next } = page((await subscriptions(ctx)).sort((a, b) => a.id.localeCompare(b.id)), p);
    return { Subscriptions: slice.map(subMember), ...(next ? { NextToken: next } : {}) };
  },

  async ListSubscriptionsByTopic(ctx, p) {
    const topic = await topicByArn(ctx, required(p, "TopicArn"));
    const { slice, next } = page((await subscriptions(ctx)).filter((s) => s.config.topicArn === topic.id), p);
    return { Subscriptions: slice.map(subMember), ...(next ? { NextToken: next } : {}) };
  },

  async GetSubscriptionAttributes(ctx, p) {
    const s = await subByArn(ctx, required(p, "SubscriptionArn"));
    return {
      Attributes: new XmlMap({
        SubscriptionArn: s.id,
        TopicArn: String(s.config.topicArn),
        Owner: ownerOf(s.id),
        Protocol: String(s.config.protocol),
        Endpoint: String(s.config.endpoint),
        ConfirmationWasAuthenticated: "false",
        PendingConfirmation: String(s.state !== "confirmed"),
        RawMessageDelivery: String(s.config.rawMessageDelivery === true),
        ...(s.config.filterPolicy ? { FilterPolicy: String(s.config.filterPolicy), FilterPolicyScope: "MessageAttributes" } : {}),
      }),
    };
  },

  async SetSubscriptionAttributes(ctx, p) {
    const s = await subByArn(ctx, required(p, "SubscriptionArn"));
    await ctx.updateSubscription(s, subscriptionSettings({ [required(p, "AttributeName")]: p.get("AttributeValue") ?? "" }));
    return {};
  },

  async Publish(ctx, p) {
    const arn = p.get("TopicArn") ?? p.get("TargetArn");
    if (!arn) throw invalid("TopicArn or TargetArn Reason: no value for required parameter");
    if (p.get("PhoneNumber")) throw invalid("PhoneNumber (CloudLab doesn't send SMS)");
    return { MessageId: await publishOne(ctx, await topicByArn(ctx, arn), p) };
  },

  async PublishBatch(ctx, p) {
    const topic = await topicByArn(ctx, required(p, "TopicArn"));
    const entries = list(p, "PublishBatchRequestEntries.member");
    if (entries.length === 0) throw new EngineError("EmptyBatchRequest", "The batch request doesn't contain any entries.", 400);
    if (entries.length > 10) throw new EngineError("TooManyEntriesInBatchRequest", "The batch request contains more entries than permissible.", 400);
    const ids = entries.map((e) => e.get("Id") ?? "");
    if (new Set(ids).size !== ids.length) throw new EngineError("BatchEntryIdsNotDistinct", "Two or more batch entries in the request have the same Id.", 400);
    const Successful: { Id: string; MessageId: string }[] = [];
    const Failed: { Id: string; Code: string; Message: string; SenderFault: boolean }[] = [];
    for (const e of entries) {
      try {
        Successful.push({ Id: e.get("Id")!, MessageId: await publishOne(ctx, topic, e) });
      } catch (err) {
        if (!(err instanceof EngineError)) throw err;
        Failed.push({ Id: e.get("Id")!, Code: err.code, Message: err.message, SenderFault: true });
      }
    }
    return { Successful, Failed };
  },

  async ListTagsForResource() {
    return { Tags: [] };
  },
};

export const SNS_OPERATIONS = Object.keys(ops);
/** What SNS lets anyone do without signing: confirm or leave a subscription, from the links it sends. */
export const SNS_UNSIGNED = ["ConfirmSubscription", "Unsubscribe"];

/** Runs one SNS API call from its Query-protocol parameters (Action=…). Returns the result object for snsResponseXml. */
export async function snsApi(params: Params, ctx: SnsApiContext): Promise<{ action: string; result: Record<string, unknown> }> {
  const action = params.get("Action") ?? "";
  const handler = ops[action];
  if (!handler) throw new EngineError("InvalidAction", action ? `CloudLab's SNS doesn't support ${action} yet.` : "Could not find operation", 400);
  return { action, result: await handler(ctx, params) };
}
