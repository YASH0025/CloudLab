import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { accountNumber } from "@/engine/ids";
import type { Delivery } from "@/engine/sns/publish";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";

let clock: Date;
let engine: Engine;
const ACCOUNT = "acct-sqs-cli";
const ACCT = accountNumber(ACCOUNT);
const ctx = () => ({ engine, accountId: ACCOUNT, region: "us-east-1", files: {} });
const run = (line: string) => executeCli(line, ctx());
const advance = (s: number) => {
  clock = new Date(clock.getTime() + s * 1000);
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

const URL = `https://sqs.us-east-1.amazonaws.com/${ACCT}/orders`;
const DLQ_URL = `https://sqs.us-east-1.amazonaws.com/${ACCT}/orders-dlq`;
const DLQ_ARN = `arn:aws:sqs:us-east-1:${ACCT}:orders-dlq`;
const counts = async (url = URL) => (await json(`aws sqs get-queue-attributes --queue-url ${url} --attribute-names All`)).Attributes;

beforeEach(() => {
  clock = new Date("2026-10-01T12:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("aws sqs", { timeout: 30_000 }, () => {
  it("creates queues idempotently and explains bad input", async () => {
    expect(await json("aws sqs create-queue --queue-name orders")).toEqual({ QueueUrl: URL });
    expect(await json("aws sqs create-queue --queue-name orders")).toEqual({ QueueUrl: URL });
    expect(await fails("aws sqs create-queue --queue-name orders --attributes VisibilityTimeout=60")).toEqual({
      code: "QueueAlreadyExists",
      message: "A queue already exists with the same name and a different value for attribute VisibilityTimeout",
    });
    expect(await fails("aws sqs create-queue --queue-name x --attributes VisibilityTimeout=99999")).toEqual({ code: "InvalidAttributeValue", message: "Invalid value for the parameter VisibilityTimeout." });
    expect(await fails("aws sqs create-queue --queue-name 'bad name'")).toMatchObject({ code: "InvalidParameterValue" });
    expect(await fails("aws sqs get-queue-url --queue-name nope")).toEqual({ code: "AWS.SimpleQueueService.NonExistentQueue", message: "The specified queue does not exist." });
    expect(await json("aws sqs get-queue-url --queue-name orders")).toEqual({ QueueUrl: URL });
    expect(await json("aws sqs list-queues")).toEqual({ QueueUrls: [URL] });
    expect((await run("aws sqs list-queues --queue-name-prefix zzz")).output).toBe("");
    expect(await counts()).toMatchObject({ QueueArn: `arn:aws:sqs:us-east-1:${ACCT}:orders`, VisibilityTimeout: "30", ApproximateNumberOfMessages: "0" });
  });

  it("hides received messages for the visibility timeout and brings them back if not deleted", async () => {
    await json("aws sqs create-queue --queue-name orders --attributes VisibilityTimeout=30");
    const sent = await json(`aws sqs send-message --queue-url ${URL} --message-body '{"id":1}' --message-attributes 'type={DataType=String,StringValue=order}'`);
    expect(sent).toMatchObject({ MD5OfMessageBody: "d2ce28b9a7fd7e4407e2b0fd499b7fe4", MessageId: expect.any(String), MD5OfMessageAttributes: expect.stringMatching(/^[0-9a-f]{32}$/) });

    const first = (await json(`aws sqs receive-message --queue-url ${URL} --attribute-names All --message-attribute-names All`)).Messages[0];
    expect(first).toMatchObject({ Body: '{"id":1}', Attributes: { ApproximateReceiveCount: "1" }, MessageAttributes: { type: { StringValue: "order", DataType: "String" } } });
    expect(await counts()).toMatchObject({ ApproximateNumberOfMessages: "0", ApproximateNumberOfMessagesNotVisible: "1" });
    // Hidden: another consumer gets nothing (and the CLI prints nothing).
    expect((await run(`aws sqs receive-message --queue-url ${URL}`)).output).toBe("");

    advance(31);
    const again = (await json(`aws sqs receive-message --queue-url ${URL} --attribute-names ApproximateReceiveCount`)).Messages[0];
    expect(again.Attributes).toEqual({ ApproximateReceiveCount: "2" });
    expect(again.ReceiptHandle).not.toBe(first.ReceiptHandle);

    expect(await fails(`aws sqs delete-message --queue-url ${URL} --receipt-handle nope`)).toEqual({
      code: "ReceiptHandleIsInvalid",
      message: 'The input receipt handle "nope" is not a valid receipt handle.',
    });
    await json(`aws sqs change-message-visibility --queue-url ${URL} --receipt-handle ${again.ReceiptHandle} --visibility-timeout 0`);
    expect(await counts()).toMatchObject({ ApproximateNumberOfMessages: "1" });
    const third = (await json(`aws sqs receive-message --queue-url ${URL}`)).Messages[0];
    await json(`aws sqs delete-message --queue-url ${URL} --receipt-handle ${third.ReceiptHandle}`);
    advance(60);
    expect(await counts()).toMatchObject({ ApproximateNumberOfMessages: "0", ApproximateNumberOfMessagesNotVisible: "0" });

    await json(`aws sqs send-message --queue-url ${URL} --message-body later --delay-seconds 10`);
    expect(await counts()).toMatchObject({ ApproximateNumberOfMessagesDelayed: "1" });
    await json(`aws sqs purge-queue --queue-url ${URL}`);
    expect(await fails(`aws sqs purge-queue --queue-url ${URL}`)).toEqual({
      code: "AWS.SimpleQueueService.PurgeQueueInProgress",
      message: "Only one PurgeQueue operation on orders is allowed every 60 seconds.",
    });
    expect(await counts()).toMatchObject({ ApproximateNumberOfMessagesDelayed: "0" });
  });

  it("moves a message received too often to the dead-letter queue", async () => {
    await json("aws sqs create-queue --queue-name orders-dlq");
    expect(await fails(`aws sqs create-queue --queue-name orders --attributes '{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"arn:aws:sqs:us-east-1:${ACCT}:nope\\",\\"maxReceiveCount\\":\\"2\\"}"}'`)).toMatchObject({
      code: "InvalidParameterValue",
      message: expect.stringContaining("Dead letter target does not exist"),
    });
    await json(`aws sqs create-queue --queue-name orders --attributes '{"VisibilityTimeout":"5","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"${DLQ_ARN}\\",\\"maxReceiveCount\\":\\"2\\"}"}'`);
    expect(JSON.parse((await counts()).RedrivePolicy)).toEqual({ deadLetterTargetArn: DLQ_ARN, maxReceiveCount: 2 });
    await json(`aws sqs send-message --queue-url ${URL} --message-body poison`);
    for (let i = 0; i < 2; i++) {
      expect((await json(`aws sqs receive-message --queue-url ${URL}`)).Messages).toHaveLength(1);
      advance(6);
    }
    // The third receive finds it has failed twice already, and moves it aside.
    expect((await run(`aws sqs receive-message --queue-url ${URL}`)).output).toBe("");
    const dead = (await json(`aws sqs receive-message --queue-url ${DLQ_URL} --attribute-names All`)).Messages[0];
    expect(dead).toMatchObject({ Body: "poison", Attributes: { DeadLetterQueueSourceArn: `arn:aws:sqs:us-east-1:${ACCT}:orders` } });

    await json(`aws sqs set-queue-attributes --queue-url ${URL} --attributes RedrivePolicy=`);
    expect((await counts()).RedrivePolicy).toBeUndefined();
  });

  it("receives from SNS only when the queue policy allows the topic", async () => {
    await json("aws sqs create-queue --queue-name orders");
    const topic = (await json("aws sns create-topic --name shop")).TopicArn;
    const queueArn = `arn:aws:sqs:us-east-1:${ACCT}:orders`;
    const sub = await json(`aws sns subscribe --topic-arn ${topic} --protocol sqs --notification-endpoint ${queueArn}`);
    expect(sub.SubscriptionArn).toMatch(/^arn:aws:sns:/);

    await json(`aws sns publish --topic-arn ${topic} --message hello`);
    const deliveries = async () => ((await engine.get(ACCOUNT, topic)).attributes.deliveries as Delivery[]) ?? [];
    expect((await deliveries())[0]).toMatchObject({ status: "failed", reason: expect.stringContaining("access policy") });

    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": topic } } }],
    });
    await json(`aws sqs set-queue-attributes --queue-url ${URL} --attributes '${JSON.stringify({ Policy: policy })}'`);
    await json(`aws sns publish --topic-arn ${topic} --subject Hi --message hello`);
    expect((await deliveries())[0]).toMatchObject({ status: "delivered" });
    const env = JSON.parse((await json(`aws sqs receive-message --queue-url ${URL}`)).Messages[0].Body);
    expect(env).toMatchObject({ Type: "Notification", TopicArn: topic, Subject: "Hi", Message: "hello" });

    await json(`aws sns set-subscription-attributes --subscription-arn ${sub.SubscriptionArn} --attribute-name RawMessageDelivery --attribute-value true`);
    await json(`aws sns publish --topic-arn ${topic} --message raw-text`);
    expect((await json(`aws sqs receive-message --queue-url ${URL}`)).Messages[0].Body).toBe("raw-text");
  });
});
