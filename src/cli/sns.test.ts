import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { accountNumber } from "@/engine/ids";
import type { Delivery } from "@/engine/sns/publish";
import type { InboxEmail } from "@/engine/services/sns";
import { checkFilterPolicy, matchesFilter } from "@/engine/services/sns";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";

let clock: Date;
let engine: Engine;
const ACCOUNT = "acct-sns-cli";
const ACCT = accountNumber(ACCOUNT);
let files: Record<string, string> = {};
const ctx = () => ({ engine, accountId: ACCOUNT, region: "us-east-1", files });
const run = (line: string) => executeCli(line, ctx());
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
async function json(line: string) {
  const r = await run(line);
  if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
  return r.output ? JSON.parse(r.output) : {};
}
async function fails(line: string) {
  const r = await run(line);
  const m = /\(([^)]+)\) when calling the (\w+) operation: ([\s\S]*)/.exec(r.output);
  if (!m) throw new Error(r.output);
  return { code: m[1], message: m[3].trim() };
}
const zip = (entries: Record<string, string>) =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])))).toString("base64");

const TOPIC = `arn:aws:sns:us-east-1:${ACCT}:orders`;
const subs = () => engine.list(ACCOUNT, { service: "sns", type: "subscription", region: "us-east-1" });
const inboxOf = async (endpoint: string) => ((await subs()).find((s) => s.config.endpoint === endpoint)?.attributes.inbox as InboxEmail[]) ?? [];
const deliveries = async () => ((await engine.get(ACCOUNT, TOPIC)).attributes.deliveries as Delivery[]) ?? [];

beforeEach(() => {
  clock = new Date("2026-10-01T12:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
  files = {};
});

describe("filter policies", () => {
  it("matches exact values, prefixes, numbers, anything-but and exists", () => {
    const p = checkFilterPolicy('{"type":["order",{"prefix":"refund-"}],"amount":[{"numeric":[">",100,"<=",500]}],"region":[{"anything-but":["test"]}]}');
    const attrs = (type: string, amount: string, region?: string) => ({
      type: { DataType: "String", StringValue: type },
      amount: { DataType: "Number", StringValue: amount },
      ...(region ? { region: { DataType: "String", StringValue: region } } : {}),
    });
    expect(matchesFilter(p, attrs("order", "200", "pune")).match).toBe(true);
    expect(matchesFilter(p, attrs("refund-full", "500", "pune")).match).toBe(true);
    expect(matchesFilter(p, attrs("Order", "200", "pune"))).toEqual({ match: false, failedKey: "type" });
    expect(matchesFilter(p, attrs("order", "50", "pune"))).toEqual({ match: false, failedKey: "amount" });
    expect(matchesFilter(p, attrs("order", "200", "test"))).toEqual({ match: false, failedKey: "region" });
    // A missing attribute never matches anything-but (only exists:false does).
    expect(matchesFilter(p, attrs("order", "200")).match).toBe(false);
    expect(matchesFilter(checkFilterPolicy('{"vip":[{"exists":false}]}'), {}).match).toBe(true);
    expect(matchesFilter(checkFilterPolicy('{"tags":["sale"]}'), { tags: { DataType: "String.Array", StringValue: '["new","sale"]' } }).match).toBe(true);
    expect(() => checkFilterPolicy('{"type":"order"}')).toThrow('Invalid parameter: FilterPolicy: "type" must be an object or an array');
    expect(() => checkFilterPolicy('{"n":[{"numeric":["!=",1]}]}')).toThrow("Unrecognized numeric range operator: !=");
  });
});

describe("aws sns", { timeout: 30_000 }, () => {
  it("creates topics idempotently and explains bad names", async () => {
    expect(await json("aws sns create-topic --name orders")).toEqual({ TopicArn: TOPIC });
    expect(await json("aws sns create-topic --name orders")).toEqual({ TopicArn: TOPIC });
    expect(await fails("aws sns create-topic --name 'bad name'")).toEqual({ code: "InvalidParameter", message: "Invalid parameter: Topic Name" });
    expect(await fails(`aws sns get-topic-attributes --topic-arn arn:aws:sns:us-east-1:${ACCT}:nope`)).toEqual({ code: "NotFound", message: "Topic does not exist" });
    expect(await fails("aws sns get-topic-attributes --topic-arn orders")).toEqual({ code: "InvalidParameter", message: "Invalid parameter: TopicArn" });
    await json(`aws sns set-topic-attributes --topic-arn ${TOPIC} --attribute-name DisplayName --attribute-value MyShop`);
    const attrs = (await json(`aws sns get-topic-attributes --topic-arn ${TOPIC}`)).Attributes;
    expect(attrs).toMatchObject({ DisplayName: "MyShop", SubscriptionsConfirmed: "0", Owner: ACCT, TopicArn: TOPIC });
    expect((await json("aws sns list-topics")).Topics).toEqual([{ TopicArn: TOPIC }]);
    // Deleting a topic that isn't there is fine.
    await json(`aws sns delete-topic --topic-arn arn:aws:sns:us-east-1:${ACCT}:nope`);
  });

  it("emails only confirmed subscribers, and the inbox gets the confirmation first", async () => {
    await json("aws sns create-topic --name orders --attributes DisplayName=MyShop");
    expect(await json(`aws sns subscribe --topic-arn ${TOPIC} --protocol email --notification-endpoint me@example.com`)).toEqual({ SubscriptionArn: "pending confirmation" });
    expect(await fails(`aws sns subscribe --topic-arn ${TOPIC} --protocol email --notification-endpoint not-an-email`)).toEqual({
      code: "InvalidParameter",
      message: "Invalid parameter: Email address",
    });
    const [mail] = await inboxOf("me@example.com");
    expect(mail).toMatchObject({ kind: "confirmation", subject: "AWS Notification - Subscription Confirmation", from: "MyShop <no-reply@sns.amazonaws.com>" });
    expect((await json("aws sns list-subscriptions")).Subscriptions[0]).toMatchObject({ SubscriptionArn: "PendingConfirmation", Protocol: "email", Endpoint: "me@example.com" });

    await json(`aws sns publish --topic-arn ${TOPIC} --message "first"`);
    expect((await deliveries())[0]).toMatchObject({ status: "pending-confirmation" });
    expect(await inboxOf("me@example.com")).toHaveLength(1);

    const token = String((await subs())[0].attributes.token);
    expect(await fails(`aws sns confirm-subscription --topic-arn ${TOPIC} --token wrong`)).toEqual({ code: "InvalidParameter", message: "Invalid parameter: Invalid token" });
    const { SubscriptionArn } = await json(`aws sns confirm-subscription --topic-arn ${TOPIC} --token ${token}`);
    expect(SubscriptionArn).toMatch(new RegExp(`^${TOPIC}:[0-9a-f-]{36}$`));

    const { MessageId } = await json(`aws sns publish --topic-arn ${TOPIC} --subject "New order" --message "Order 42 placed"`);
    const inbox = await inboxOf("me@example.com");
    expect(inbox[0]).toMatchObject({ kind: "notification", subject: "New order", messageId: MessageId });
    expect(inbox[0].body).toMatch(/^Order 42 placed\n\n--\nIf you wish to stop receiving/);

    expect(await fails(`aws sns publish --topic-arn ${TOPIC} --message ""`)).toEqual({ code: "InvalidParameter", message: "Invalid parameter: Empty message" });
    expect(await fails(`aws sns publish --topic-arn ${TOPIC} --message x --message-structure json`)).toEqual({
      code: "InvalidParameter",
      message: "Invalid parameter: Message Structure - JSON message body failed to parse",
    });
    expect(await fails(`aws sns publish --topic-arn ${TOPIC} --message '{"email":"hi"}' --message-structure json`)).toEqual({
      code: "InvalidParameter",
      message: "Invalid parameter: Message Structure - No default entry in JSON message body",
    });
    await json(`aws sns publish --topic-arn ${TOPIC} --message '{"default":"for programs","email":"for people"}' --message-structure json`);
    expect((await inboxOf("me@example.com"))[0].body).toMatch(/^for people/);

    // Unsubscribing a pending subscription isn't possible by ARN; deleting the topic removes everything.
    await json(`aws sns unsubscribe --subscription-arn ${SubscriptionArn}`);
    expect(await subs()).toHaveLength(0);
    await json(`aws sns subscribe --topic-arn ${TOPIC} --protocol email --notification-endpoint me@example.com`);
    await json(`aws sns delete-topic --topic-arn ${TOPIC}`);
    expect(await subs()).toHaveLength(0);
  });

  it("filters by message attributes and needs Lambda permission to invoke", async () => {
    const trust = `'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'`;
    await json(`aws iam create-role --role-name fn --assume-role-policy-document ${trust}`);
    files["f.zip"] = zip({ "index.mjs": "export const handler = async (e) => { console.log('got', e.Records[0].Sns.Message); return 1; };" });
    await json(`aws lambda create-function --function-name worker --runtime nodejs22.x --handler index.handler --role arn:aws:iam::${ACCT}:role/fn --zip-file fileb://f.zip`);
    advance(2_000);
    const fnArn = `arn:aws:lambda:us-east-1:${ACCT}:function:worker`;

    await json("aws sns create-topic --name orders");
    const sub = await json(
      `aws sns subscribe --topic-arn ${TOPIC} --protocol lambda --notification-endpoint ${fnArn} --attributes 'FilterPolicy={"type":["order"]}'`,
    );
    expect(sub.SubscriptionArn).toMatch(/^arn:aws:sns:/);
    expect((await json(`aws sns get-subscription-attributes --subscription-arn ${sub.SubscriptionArn}`)).Attributes).toMatchObject({
      PendingConfirmation: "false",
      FilterPolicy: '{"type":["order"]}',
    });

    await json(`aws sns publish --topic-arn ${TOPIC} --message hi --message-attributes 'type={DataType=String,StringValue=order}'`);
    expect((await deliveries())[0]).toMatchObject({ status: "failed", reason: expect.stringContaining("SNS isn't allowed to invoke worker") });

    await json(`aws lambda add-permission --function-name worker --statement-id sns --action lambda:InvokeFunction --principal sns.amazonaws.com --source-arn ${TOPIC}`);
    await json(`aws sns publish --topic-arn ${TOPIC} --message hi --message-attributes '{"type":{"DataType":"String","StringValue":"order"}}'`);
    expect((await deliveries())[0]).toMatchObject({ status: "delivered" });
    const fn = await engine.get(ACCOUNT, fnArn);
    expect((fn.attributes.invocations as { source: string }[])[0].source).toBe("sns:orders");

    await json(`aws sns publish --topic-arn ${TOPIC} --message hi --message-attributes 'type={DataType=String,StringValue=refund}'`);
    expect((await deliveries())[0]).toMatchObject({ status: "filtered", reason: expect.stringContaining('"type" (refund)') });

    await json(`aws sns set-subscription-attributes --subscription-arn ${sub.SubscriptionArn} --attribute-name FilterPolicy --attribute-value '{}'`);
    await json(`aws sns publish --topic-arn ${TOPIC} --message hi`);
    expect((await deliveries())[0]).toMatchObject({ status: "delivered" });
  });

  it("emails when a CloudWatch alarm changes state", async () => {
    await json("aws sns create-topic --name orders");
    await json(`aws sns subscribe --topic-arn ${TOPIC} --protocol email --notification-endpoint ops@example.com`);
    const s = (await subs())[0];
    await json(`aws sns confirm-subscription --topic-arn ${TOPIC} --token ${s.attributes.token}`);
    await json(
      `aws cloudwatch put-metric-alarm --alarm-name few-orders --namespace Shop --metric-name Orders --statistic Sum --period 60 --evaluation-periods 1 --threshold 1 --comparison-operator LessThanThreshold --alarm-actions ${TOPIC} --ok-actions ${TOPIC}`,
    );
    expect((await json("aws cloudwatch describe-alarms --alarm-names few-orders")).MetricAlarms[0]).toMatchObject({ AlarmActions: [TOPIC], OKActions: [TOPIC] });
    await json('aws cloudwatch set-alarm-state --alarm-name few-orders --state-value ALARM --state-reason "testing notifications"');
    const [mail] = await inboxOf("ops@example.com");
    expect(mail.subject).toBe('ALARM: "few-orders" in US East (N. Virginia)');
    expect(mail.body).toMatch(/^You are receiving this email because your Amazon CloudWatch Alarm "few-orders"/);

    // Deleting the topic quietly drops it from the alarm.
    await json(`aws sns delete-topic --topic-arn ${TOPIC}`);
    expect((await json("aws cloudwatch describe-alarms --alarm-names few-orders")).MetricAlarms[0].AlarmActions).toEqual([]);
  });
});
