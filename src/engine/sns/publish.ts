import { randomUUID } from "node:crypto";
import { REGIONS } from "../catalog";
import type { Engine } from "../engine";
import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import { allowsService, invokeFunction } from "../lambda/invoke";
import {
  checkFilterPolicy,
  functionArnOf,
  invalid,
  KEEP_DELIVERIES,
  KEEP_INBOX,
  matchesFilter,
  senderOf,
  topicNameOf,
  type InboxEmail,
  type MessageAttribute,
} from "../services/sns";
import { policyAllowsService, sendMessage } from "../sqs/queue";
import { urlFromArn } from "../services/sqs";
import type { Resource } from "../types";

/**
 * Publishing: SNS checks the message, then hands a copy to each confirmed
 * subscription whose filter policy matches. What happened to each copy is
 * kept on the topic ("deliveries"), which AWS only shows through metrics and
 * delivery logs; CloudLab shows it so you can see why something didn't arrive.
 */

export const MAX_MESSAGE_BYTES = 256 * 1024;

export type DeliveryStatus = "delivered" | "failed" | "filtered" | "pending-confirmation";

export interface Delivery {
  at: string;
  messageId: string;
  subject?: string;
  subscriptionArn: string;
  protocol: string;
  endpoint: string;
  status: DeliveryStatus;
  /** Why it failed or was skipped, or a note (e.g. the function itself threw). */
  reason?: string;
}

export interface PublishInput {
  message: string;
  subject?: string;
  /** "json": `message` is a JSON object with a "default" message and optional per-protocol ones. */
  messageStructure?: string;
  attributes?: Record<string, MessageAttribute>;
}

export interface PublishResult {
  messageId: string;
  deliveries: Delivery[];
}

const regionName = (code: string) => REGIONS.find((r) => r.code === code)?.name ?? code;

function checkInput(input: PublishInput): { perProtocol: Record<string, string> | null } {
  if (input.message === undefined || input.message === null || input.message === "") throw invalid("Empty message");
  if (Buffer.byteLength(input.message) > MAX_MESSAGE_BYTES) throw invalid("Message too long");
  if (input.subject !== undefined) {
    if (input.subject.length === 0 || input.subject.length > 100 || !/^[\x20-\x7E]+$/.test(input.subject)) throw invalid("Subject");
  }
  for (const [name, a] of Object.entries(input.attributes ?? {})) {
    if (!a || typeof a.DataType !== "string") throw new EngineError("ParameterValueInvalid", `The message attribute '${name}' must contain non-empty message attribute type.`);
    if (!/^(String|Number|Binary|String\.Array)(\..+)?$/.test(a.DataType)) {
      throw new EngineError("ParameterValueInvalid", `The message attribute '${name}' has an invalid message attribute type, the set of supported type prefixes is Binary, Number, and String.`);
    }
    if (a.StringValue === undefined || a.StringValue === "") throw new EngineError("ParameterValueInvalid", `The message attribute '${name}' must contain non-empty message attribute value for message attribute type '${a.DataType}'.`);
    if (a.DataType.startsWith("Number") && Number.isNaN(Number(a.StringValue))) {
      throw new EngineError("ParameterValueInvalid", `Could not cast message attribute '${name}' value to number.`);
    }
  }
  if (input.messageStructure === undefined) return { perProtocol: null };
  if (input.messageStructure !== "json") throw invalid("MessageStructure");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.message);
  } catch {
    throw invalid("Message Structure - JSON message body failed to parse");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("Message Structure - JSON message body failed to parse");
  const map = parsed as Record<string, unknown>;
  if (typeof map.default !== "string") throw invalid("Message Structure - No default entry in JSON message body");
  return { perProtocol: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) };
}

/** The JSON document SNS sends to email-json, Lambda and (raw delivery off) queues. */
export function envelope(topic: Resource, messageId: string, message: string, subject: string | undefined, attributes: Record<string, MessageAttribute>, at: string, sub: Resource) {
  const host = `https://sns.${topic.region}.amazonaws.com`;
  return {
    Type: "Notification",
    MessageId: messageId,
    TopicArn: topic.id,
    ...(subject !== undefined ? { Subject: subject } : {}),
    Message: message,
    Timestamp: at,
    SignatureVersion: "1",
    Signature: "EXAMPLE",
    SigningCertURL: `${host}/SimpleNotificationService-0000000000000000000000.pem`,
    UnsubscribeURL: `${host}/?Action=Unsubscribe&SubscriptionArn=${sub.id}`,
    ...(Object.keys(attributes).length
      ? { MessageAttributes: Object.fromEntries(Object.entries(attributes).map(([k, a]) => [k, { Type: a.DataType, Value: a.StringValue }])) }
      : {}),
  };
}

async function deliverEmail(engine: Engine, sub: Resource, topic: Resource, email: Omit<InboxEmail, "id" | "from" | "kind">) {
  const inbox = (sub.attributes.inbox as InboxEmail[] | undefined) ?? [];
  const item: InboxEmail = { id: randomUUID(), from: senderOf(topic), kind: "notification", ...email };
  await engine.setAttributes(sub.accountId, sub.id, { inbox: [item, ...inbox].slice(0, KEEP_INBOX) });
}

const footer = (sub: Resource) =>
  `\n\n--\nIf you wish to stop receiving notifications from this topic, please click or visit the link below to unsubscribe:\nhttps://sns.${sub.region}.amazonaws.com/unsubscribe.html?SubscriptionArn=${sub.id}\n\nPlease do not reply directly to this email.`;

async function deliverOne(
  engine: Engine,
  topic: Resource,
  sub: Resource,
  m: { messageId: string; at: string; subject?: string; text: (protocol: string) => string; attributes: Record<string, MessageAttribute> },
): Promise<Omit<Delivery, "at" | "messageId" | "subject" | "subscriptionArn" | "protocol" | "endpoint">> {
  if (sub.state !== "confirmed") return { status: "pending-confirmation", reason: "Not confirmed yet: open the subscription's inbox and confirm it." };
  if (sub.config.filterPolicy) {
    const f = matchesFilter(checkFilterPolicy(String(sub.config.filterPolicy)), m.attributes);
    if (!f.match) {
      const attr = m.attributes[f.failedKey!];
      return {
        status: "filtered",
        reason: attr
          ? `Filter policy: the message's "${f.failedKey}" (${attr.StringValue}) isn't one the subscription wants.`
          : `Filter policy: the message has no "${f.failedKey}" attribute.`,
      };
    }
  }
  const protocol = String(sub.config.protocol);
  const text = m.text(protocol);
  if (protocol === "email") {
    await deliverEmail(engine, sub, topic, { at: m.at, subject: m.subject ?? "AWS Notification Message", body: text + footer(sub), messageId: m.messageId });
    return { status: "delivered" };
  }
  if (protocol === "email-json") {
    const doc = envelope(topic, m.messageId, text, m.subject, m.attributes, m.at, sub);
    await deliverEmail(engine, sub, topic, { at: m.at, subject: m.subject ?? "AWS Notification Message", body: JSON.stringify(doc, null, 2), messageId: m.messageId });
    return { status: "delivered" };
  }
  if (protocol === "lambda") {
    const fnArn = functionArnOf(String(sub.config.endpoint));
    const fn = await engine.get(sub.accountId, fnArn).catch(() => null);
    if (!fn || fn.type !== "function") return { status: "failed", reason: `The function ${fnArn.split(":").pop()} doesn't exist (or is in another account).` };
    if (!allowsService(fn, "sns.amazonaws.com", topic.id)) {
      return {
        status: "failed",
        reason: `SNS isn't allowed to invoke ${fn.name}: its resource-based policy needs a statement for sns.amazonaws.com with this topic as the source ARN (aws lambda add-permission).`,
      };
    }
    const event = {
      Records: [{ EventSource: "aws:sns", EventVersion: "1.0", EventSubscriptionArn: sub.id, Sns: envelope(topic, m.messageId, text, m.subject, m.attributes, m.at, sub) }],
    };
    try {
      const r = await invokeFunction(engine, sub.accountId, fn, event, `sns:${topicNameOf(topic.id)}`);
      // An asynchronous invoke: SNS's job is done once Lambda accepts the event, even if the code throws.
      return r.functionError ? { status: "delivered", reason: `Delivered, but the function failed (see its logs, request ${r.requestId}).` } : { status: "delivered" };
    } catch (e) {
      return { status: "failed", reason: e instanceof EngineError ? `${e.code}: ${e.message}` : String(e) };
    }
  }
  if (protocol === "sqs") {
    const arn = String(sub.config.endpoint);
    const q = await engine.get(sub.accountId, urlFromArn(arn)).catch(() => null);
    if (!q || q.type !== "queue") return { status: "failed", reason: `The queue ${arn.split(":").pop()} doesn't exist (or is in another account).` };
    if (!policyAllowsService(q, "sns.amazonaws.com", "sqs:SendMessage", topic.id)) {
      return {
        status: "failed",
        reason: `SNS isn't allowed to send to ${q.name}: the queue's access policy needs to allow sns.amazonaws.com to sqs:SendMessage, with this topic as aws:SourceArn.`,
      };
    }
    const raw = sub.config.rawMessageDelivery === true;
    try {
      await sendMessage(engine, q, {
        body: raw ? text : JSON.stringify(envelope(topic, m.messageId, text, m.subject, m.attributes, m.at, sub), null, 2),
        attributes: raw ? Object.fromEntries(Object.entries(m.attributes).filter(([, a]) => a.DataType !== "String.Array")) : {},
        senderId: "AIDAIT2UOQQY3AUEKVGXU",
        delaySeconds: undefined,
      });
      return { status: "delivered" };
    } catch (e) {
      return { status: "failed", reason: e instanceof EngineError ? `${e.code}: ${e.message}` : String(e) };
    }
  }
  return { status: "failed", reason: `CloudLab can't deliver to the ${protocol} protocol yet.` };
}

/** Publish: checks the message, fans it out, records deliveries and metrics. */
export async function publish(engine: Engine, accountId: string, topic: Resource, input: PublishInput): Promise<PublishResult> {
  const { perProtocol } = checkInput(input);
  const messageId = randomUUID();
  const at = engine.now().toISOString();
  const attributes = input.attributes ?? {};
  const text = (protocol: string) => (perProtocol ? (perProtocol[protocol] ?? perProtocol.default) : input.message);

  const subs = (await engine.list(accountId, { service: "sns", type: "subscription", region: topic.region })).filter((s) => s.config.topicArn === topic.id);
  const deliveries: Delivery[] = [];
  for (const sub of subs) {
    const outcome = await deliverOne(engine, topic, sub, { messageId, at, subject: input.subject, text, attributes });
    deliveries.push({ at, messageId, subject: input.subject, subscriptionArn: sub.id, protocol: String(sub.config.protocol), endpoint: String(sub.config.endpoint), ...outcome });
  }

  const fresh = await engine.get(accountId, topic.id);
  const previous = (fresh.attributes.deliveries as Delivery[] | undefined) ?? [];
  const published = (fresh.attributes.published as { count?: number } | undefined)?.count ?? 0;
  await engine.setAttributes(accountId, topic.id, {
    deliveries: [...deliveries, ...previous].slice(0, KEEP_DELIVERIES),
    published: { count: published + 1, lastAt: at, lastMessageId: messageId },
  });

  const dims = { TopicName: topic.name };
  const count = (s: DeliveryStatus) => deliveries.filter((d) => d.status === s).length;
  await engine.metrics.record(accountId, topic.region, "AWS/SNS", "NumberOfMessagesPublished", dims, 1, "Count");
  await engine.metrics.record(accountId, topic.region, "AWS/SNS", "PublishSize", dims, Buffer.byteLength(input.message), "Bytes");
  if (count("delivered")) await engine.metrics.record(accountId, topic.region, "AWS/SNS", "NumberOfNotificationsDelivered", dims, count("delivered"), "Count");
  if (count("failed")) await engine.metrics.record(accountId, topic.region, "AWS/SNS", "NumberOfNotificationsFailed", dims, count("failed"), "Count");
  if (count("filtered")) await engine.metrics.record(accountId, topic.region, "AWS/SNS", "NumberOfNotificationsFilteredOut", dims, count("filtered"), "Count");

  return { messageId, deliveries };
}

/** ConfirmSubscription: the token from the confirmation email. */
export async function confirmSubscription(engine: Engine, accountId: string, topic: Resource, token: string): Promise<Resource> {
  const subs = (await engine.list(accountId, { service: "sns", type: "subscription", region: topic.region })).filter((s) => s.config.topicArn === topic.id);
  const sub = subs.find((s) => s.attributes.token === token);
  if (!sub) throw invalid("Invalid token");
  if (sub.state === "confirmed") return sub;
  return engine.runAction(accountId, sub.id, "confirm");
}

// ---------- CloudWatch alarm notifications ----------

/** What CloudWatch publishes when an alarm changes state: JSON for programs, readable text for email. */
export function alarmNotification(alarm: Resource, oldState: string, newState: string, reason: string, at: string) {
  const c = alarm.config;
  const region = regionName(alarm.region);
  const doc = {
    AlarmName: alarm.name,
    AlarmDescription: (c.description as string | undefined) ?? null,
    AWSAccountId: accountNumber(alarm.accountId),
    AlarmConfigurationUpdatedTimestamp: alarm.updatedAt,
    NewStateValue: newState,
    NewStateReason: reason,
    StateChangeTime: at,
    Region: region,
    AlarmArn: alarm.id,
    OldStateValue: oldState,
    Trigger: {
      MetricName: c.metricName,
      Namespace: c.namespace,
      StatisticType: "Statistic",
      Statistic: String(c.statistic).toUpperCase(),
      Unit: null,
      Dimensions: ((c.dimensions as { name: string; value: string }[] | undefined) ?? []).map((d) => ({ value: d.value, name: d.name })),
      Period: c.period,
      EvaluationPeriods: c.evaluationPeriods,
      ComparisonOperator: c.comparisonOperator,
      Threshold: c.threshold,
      TreatMissingData: c.treatMissingData,
    },
  };
  const email = [
    `You are receiving this email because your Amazon CloudWatch Alarm "${alarm.name}" in the ${region} region has entered the ${newState} state, because "${reason}" at "${at}".`,
    ``,
    `Alarm Details:`,
    `- Name:                       ${alarm.name}`,
    `- Description:                ${c.description ?? ""}`,
    `- State Change:               ${oldState} -> ${newState}`,
    `- Reason for State Change:    ${reason}`,
    `- Timestamp:                  ${at}`,
    `- AWS Account:                ${accountNumber(alarm.accountId)}`,
    `- Alarm Arn:                  ${alarm.id}`,
    ``,
    `Threshold:`,
    `- The alarm is in the ALARM state when the metric is ${c.comparisonOperator} ${c.threshold} for at least ${c.datapointsToAlarm ?? c.evaluationPeriods} of the last ${c.evaluationPeriods} period(s) of ${c.period} seconds.`,
    ``,
    `Monitored Metric:`,
    `- MetricNamespace:            ${c.namespace}`,
    `- MetricName:                 ${c.metricName}`,
    `- Statistic:                  ${c.statistic}`,
  ].join("\n");
  return {
    subject: `${newState}: "${alarm.name}" in ${region}`.slice(0, 100),
    message: JSON.stringify({ default: JSON.stringify(doc), email }),
  };
}

/** Runs an alarm's actions for its new state: publishes to each SNS topic listed. Never throws. */
export async function runAlarmActions(engine: Engine, alarm: Resource, oldState: string, newState: string, reason: string, at: string) {
  if (alarm.config.actionsEnabled === false) return;
  const key = newState === "ALARM" ? "alarmActions" : newState === "OK" ? "okActions" : null;
  if (!key) return;
  const arns = (alarm.config[key] as string[] | undefined) ?? [];
  for (const arn of arns) {
    try {
      const topic = await engine.get(alarm.accountId, arn);
      if (topic.type !== "topic") continue;
      await publish(engine, alarm.accountId, topic, { ...alarmNotification(alarm, oldState, newState, reason, at), messageStructure: "json" });
    } catch (e) {
      console.error("[cloudlab] alarm action failed", arn, e);
    }
  }
}
