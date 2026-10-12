import { accountNumber } from "@/engine/ids";
import { confirmSubscription, publish } from "@/engine/sns/publish";
import { checkFilterPolicy, invalid, PROTOCOLS, type MessageAttribute } from "@/engine/services/sns";
import type { Resource } from "@/engine/types";
import type { Args, CliContext, Command } from "./commands";
import { LocalPathError, UsageError } from "./parse";

/**
 * `aws sns`: topics, subscriptions and publishing. Subscribing from the CLI
 * does exactly what you ask and nothing more: unlike the Lambda console, it
 * doesn't give SNS permission to invoke a function (that's add-permission).
 */

const cmd = (c: Command) => c;

const listOf = (ctx: CliContext, type: "topic" | "subscription") => ctx.engine.list(ctx.accountId, { service: "sns", type, region: ctx.region });

const topicByArn = (ctx: CliContext, arn: string) => ctx.engine.getTyped(ctx.accountId, arn, "sns", "topic", ctx.region);

async function subByArn(ctx: CliContext, arn: string): Promise<Resource> {
  if (arn === "pending confirmation" || arn === "PendingConfirmation") {
    throw invalid("SubscriptionArn (a subscription waiting for confirmation has no ARN yet: confirm it first)");
  }
  return ctx.engine.getTyped(ctx.accountId, arn, "sns", "subscription", ctx.region);
}

/** A subscription's ARN as the API shows it: not until it's confirmed. */
const shownArn = (s: Resource) => (s.state === "confirmed" ? s.id : "PendingConfirmation");

/** file://message.txt or the text itself. */
function textArg(ctx: CliContext, value: string): string {
  const m = /^file:\/\/(.+)$/.exec(value);
  if (!m) return value;
  const data = ctx.files?.[m[1]];
  if (data === undefined) throw new LocalPathError(m[1]);
  return Buffer.from(data, "base64").toString("utf8");
}

const ATTRIBUTE_KEYS = ["FilterPolicy", "FilterPolicyScope", "RawMessageDelivery", "DisplayName", "DeliveryPolicy", "Policy"];

/** --attributes FilterPolicy='{"a":["b"]}',RawMessageDelivery=true or a JSON object. */
function attributesArg(ctx: CliContext, args: Args): Record<string, string> {
  const raw = args.raw("attributes").join(" ").trim();
  if (!raw) return {};
  const text = textArg(ctx, raw);
  if (text.startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new UsageError(`Error parsing parameter '--attributes': Invalid JSON: ${text}`);
    }
  }
  const out: Record<string, string> = {};
  const parts = text.split(new RegExp(`,(?=(?:${ATTRIBUTE_KEYS.join("|")})=)`));
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) throw new UsageError(`Error parsing parameter '--attributes': Expected: '=', received: end of input for input: ${part}`);
    out[part.slice(0, eq)] = part.slice(eq + 1).replace(/^'([\s\S]*)'$/, "$1");
  }
  return out;
}

/**
 * --message-attributes '{"type":{"DataType":"String","StringValue":"order"}}'
 * or shorthand type={DataType=String,StringValue=order},amount={DataType=Number,StringValue=12}
 */
function messageAttributesArg(ctx: CliContext, args: Args): Record<string, MessageAttribute> {
  const raw = args.raw("message-attributes").join(" ").trim();
  if (!raw) return {};
  const text = textArg(ctx, raw);
  if (text.startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new UsageError(`Error parsing parameter '--message-attributes': Invalid JSON: ${text}`);
    }
  }
  const out: Record<string, MessageAttribute> = {};
  const re = /([^=,{}\s]+)=\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  let matched = 0;
  while ((m = re.exec(text))) {
    matched += m[0].length;
    const fields = Object.fromEntries(
      m[2].split(/,(?=\s*(?:DataType|StringValue|BinaryValue)=)/).map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
      }),
    );
    out[m[1]] = { DataType: fields.DataType, StringValue: fields.StringValue };
  }
  if (matched === 0) throw new UsageError(`Error parsing parameter '--message-attributes': Expected: '=', received: end of input for input: ${text}`);
  return out;
}

async function topicAttributes(ctx: CliContext, t: Resource) {
  const subs = (await listOf(ctx, "subscription")).filter((s) => s.config.topicArn === t.id);
  const account = accountNumber(ctx.accountId);
  return {
    Policy: JSON.stringify({
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
    }),
    Owner: account,
    SubscriptionsPending: String(subs.filter((s) => s.state !== "confirmed").length),
    TopicArn: t.id,
    EffectiveDeliveryPolicy: JSON.stringify({ http: { defaultHealthyRetryPolicy: { minDelayTarget: 20, maxDelayTarget: 20, numRetries: 3 }, disableSubscriptionOverrides: false } }),
    SubscriptionsConfirmed: String(subs.filter((s) => s.state === "confirmed").length),
    DisplayName: String(t.config.displayName ?? ""),
    SubscriptionsDeleted: "0",
  };
}

function subOut(ctx: CliContext, s: Resource) {
  return { SubscriptionArn: shownArn(s), Owner: accountNumber(ctx.accountId), Protocol: s.config.protocol, Endpoint: s.config.endpoint, TopicArn: s.config.topicArn };
}

const PROTOCOL_LIST = [...PROTOCOLS];
const KNOWN_PROTOCOLS = ["http", "https", "email", "email-json", "sms", "sqs", "application", "lambda", "firehose"];

export const SNS_COMMANDS: Command[] = [
  cmd({
    service: "sns",
    operation: "create-topic",
    apiName: "CreateTopic",
    summary: "Create a topic (or get the ARN of the one with that name)",
    usage: "--name <name> [--attributes DisplayName=<text>]",
    mutates: true,
    async run(args, ctx) {
      const name = args.required("name");
      const attrs = attributesArg(ctx, args);
      for (const k of Object.keys(attrs)) if (k !== "DisplayName") throw invalid("Attributes Reason: Unknown attribute (CloudLab supports DisplayName)");
      // CreateTopic is idempotent: the same name gives back the same topic.
      const existing = (await listOf(ctx, "topic")).find((t) => t.name === name);
      if (existing) {
        if (attrs.DisplayName !== undefined && attrs.DisplayName !== (existing.config.displayName ?? "")) throw invalid("Topic already exists with different attributes");
        return { TopicArn: existing.id };
      }
      const t = await ctx.engine.create(ctx.accountId, { service: "sns", type: "topic", region: ctx.region, config: { name, displayName: attrs.DisplayName } });
      return { TopicArn: t.id };
    },
  }),
  cmd({
    service: "sns",
    operation: "list-topics",
    apiName: "ListTopics",
    summary: "List topics",
    mutates: false,
    async run(_args, ctx) {
      return { Topics: (await listOf(ctx, "topic")).map((t) => ({ TopicArn: t.id })).sort((a, b) => a.TopicArn.localeCompare(b.TopicArn)) };
    },
  }),
  cmd({
    service: "sns",
    operation: "delete-topic",
    apiName: "DeleteTopic",
    summary: "Delete a topic and all its subscriptions",
    usage: "--topic-arn <arn>",
    mutates: true,
    async run(args, ctx) {
      const arn = args.required("topic-arn");
      // Deleting a topic that doesn't exist isn't an error.
      const t = (await listOf(ctx, "topic")).find((x) => x.id === arn);
      if (!t) {
        if (!/^arn:aws:sns:/.test(arn)) throw invalid("TopicArn");
        return;
      }
      await ctx.engine.remove(ctx.accountId, t.id);
    },
  }),
  cmd({
    service: "sns",
    operation: "get-topic-attributes",
    apiName: "GetTopicAttributes",
    summary: "Show a topic's settings and subscription counts",
    usage: "--topic-arn <arn>",
    mutates: false,
    async run(args, ctx) {
      return { Attributes: await topicAttributes(ctx, await topicByArn(ctx, args.required("topic-arn"))) };
    },
  }),
  cmd({
    service: "sns",
    operation: "set-topic-attributes",
    apiName: "SetTopicAttributes",
    summary: "Change a topic setting (DisplayName)",
    usage: "--topic-arn <arn> --attribute-name DisplayName --attribute-value <text>",
    mutates: true,
    async run(args, ctx) {
      const t = await topicByArn(ctx, args.required("topic-arn"));
      const name = args.required("attribute-name");
      if (name !== "DisplayName") throw invalid("AttributeName (CloudLab supports DisplayName)");
      await ctx.engine.update(ctx.accountId, t.id, { displayName: args.one("attribute-value") ?? "" });
    },
  }),
  cmd({
    service: "sns",
    operation: "subscribe",
    apiName: "Subscribe",
    summary: "Subscribe an email address or Lambda function to a topic",
    usage: "--topic-arn <arn> --protocol <email|email-json|lambda> --notification-endpoint <address-or-arn> [--attributes FilterPolicy=<json>] [--return-subscription-arn]",
    mutates: true,
    async run(args, ctx) {
      const t = await topicByArn(ctx, args.required("topic-arn"));
      const protocol = args.required("protocol");
      if (!KNOWN_PROTOCOLS.includes(protocol)) throw invalid("Invalid protocol type: " + protocol);
      if (!PROTOCOL_LIST.includes(protocol as (typeof PROTOCOLS)[number])) {
        throw invalid(`Protocol: CloudLab doesn't simulate ${protocol} subscriptions yet (try ${PROTOCOL_LIST.join(", ")})`);
      }
      const endpoint = args.one("notification-endpoint");
      if (!endpoint) throw invalid("Endpoint");
      const attrs = attributesArg(ctx, args);
      for (const k of Object.keys(attrs)) {
        if (k !== "FilterPolicy" && k !== "FilterPolicyScope") throw invalid(`Attributes Reason: Unknown attribute ${k} (CloudLab supports FilterPolicy)`);
      }
      if (attrs.FilterPolicyScope && attrs.FilterPolicyScope !== "MessageAttributes") throw invalid("FilterPolicyScope: CloudLab filters on MessageAttributes only");
      const existing = (await listOf(ctx, "subscription")).find((s) => s.config.topicArn === t.id && s.config.protocol === protocol && s.config.endpoint === endpoint.trim());
      const returnArn = args.bool("return-subscription-arn") === true;
      if (existing) return { SubscriptionArn: returnArn || existing.state === "confirmed" ? existing.id : "pending confirmation" };
      const s = await ctx.engine.create(ctx.accountId, {
        service: "sns",
        type: "subscription",
        region: ctx.region,
        config: { topicArn: t.id, protocol, endpoint, filterPolicy: attrs.FilterPolicy },
      });
      return { SubscriptionArn: protocol === "lambda" || returnArn ? s.id : "pending confirmation" };
    },
  }),
  cmd({
    service: "sns",
    operation: "confirm-subscription",
    apiName: "ConfirmSubscription",
    summary: "Confirm a subscription with the token from its confirmation email",
    usage: "--topic-arn <arn> --token <token>",
    mutates: true,
    async run(args, ctx) {
      const t = await topicByArn(ctx, args.required("topic-arn"));
      const s = await confirmSubscription(ctx.engine, ctx.accountId, t, args.required("token"));
      return { SubscriptionArn: s.id };
    },
  }),
  cmd({
    service: "sns",
    operation: "unsubscribe",
    apiName: "Unsubscribe",
    summary: "Delete a subscription",
    usage: "--subscription-arn <arn>",
    mutates: true,
    async run(args, ctx) {
      const s = await subByArn(ctx, args.required("subscription-arn"));
      await ctx.engine.remove(ctx.accountId, s.id);
    },
  }),
  cmd({
    service: "sns",
    operation: "list-subscriptions",
    apiName: "ListSubscriptions",
    summary: "List every subscription in the region",
    mutates: false,
    async run(_args, ctx) {
      return { Subscriptions: (await listOf(ctx, "subscription")).map((s) => subOut(ctx, s)) };
    },
  }),
  cmd({
    service: "sns",
    operation: "list-subscriptions-by-topic",
    apiName: "ListSubscriptionsByTopic",
    summary: "List a topic's subscriptions",
    usage: "--topic-arn <arn>",
    mutates: false,
    async run(args, ctx) {
      const t = await topicByArn(ctx, args.required("topic-arn"));
      return { Subscriptions: (await listOf(ctx, "subscription")).filter((s) => s.config.topicArn === t.id).map((s) => subOut(ctx, s)) };
    },
  }),
  cmd({
    service: "sns",
    operation: "get-subscription-attributes",
    apiName: "GetSubscriptionAttributes",
    summary: "Show a subscription's settings, including its filter policy",
    usage: "--subscription-arn <arn>",
    mutates: false,
    async run(args, ctx) {
      const s = await subByArn(ctx, args.required("subscription-arn"));
      return {
        Attributes: {
          ConfirmationWasAuthenticated: "true",
          PendingConfirmation: String(s.state !== "confirmed"),
          TopicArn: s.config.topicArn,
          Owner: accountNumber(ctx.accountId),
          RawMessageDelivery: "false",
          SubscriptionArn: s.id,
          Protocol: s.config.protocol,
          Endpoint: s.config.endpoint,
          ...(s.config.filterPolicy ? { FilterPolicy: s.config.filterPolicy, FilterPolicyScope: "MessageAttributes" } : {}),
          SubscriptionPrincipal: `arn:aws:iam::${accountNumber(ctx.accountId)}:root`,
        },
      };
    },
  }),
  cmd({
    service: "sns",
    operation: "set-subscription-attributes",
    apiName: "SetSubscriptionAttributes",
    summary: "Set or remove a subscription's filter policy",
    usage: "--subscription-arn <arn> --attribute-name FilterPolicy --attribute-value <json>",
    mutates: true,
    async run(args, ctx) {
      const s = await subByArn(ctx, args.required("subscription-arn"));
      const name = args.required("attribute-name");
      if (name !== "FilterPolicy") throw invalid("AttributeName (CloudLab supports FilterPolicy)");
      const value = textArg(ctx, args.one("attribute-value") ?? "").trim();
      // An empty policy removes it.
      if (value && value !== "{}") checkFilterPolicy(value);
      await ctx.engine.update(ctx.accountId, s.id, { filterPolicy: value && value !== "{}" ? value : undefined });
    },
  }),
  cmd({
    service: "sns",
    operation: "publish",
    apiName: "Publish",
    summary: "Send a message to everyone subscribed to a topic",
    usage: "--topic-arn <arn> --message <text|file://msg.txt> [--subject <text>] [--message-attributes <name>={DataType=String,StringValue=<v>}] [--message-structure json]",
    mutates: true,
    async run(args, ctx) {
      const arn = args.one("topic-arn") ?? args.one("target-arn");
      if (!arn) {
        if (args.has("phone-number")) throw invalid("PhoneNumber: CloudLab doesn't send SMS");
        throw invalid("TopicArn or TargetArn Reason: no value for required parameter");
      }
      const t = await topicByArn(ctx, arn);
      const message = args.one("message");
      if (message === undefined) throw new UsageError("the following arguments are required: --message");
      const r = await publish(ctx.engine, ctx.accountId, t, {
        message: textArg(ctx, message),
        subject: args.one("subject"),
        messageStructure: args.one("message-structure"),
        attributes: messageAttributesArg(ctx, args),
      });
      return { MessageId: r.messageId };
    },
  }),
];
