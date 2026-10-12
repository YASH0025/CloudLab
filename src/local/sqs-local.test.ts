import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EngineError } from "@/engine/errors";
import { QueueWaiters, sqsApi, type SqsApiContext } from "@/engine/sqs/api";
import { FileQueueHost } from "./sqs-host";

const ACCOUNT = "123456789012";

function setup(dir = mkdtempSync(path.join(tmpdir(), "cl-sqs-"))) {
  const host = new FileQueueHost(dir);
  const waiters = new QueueWaiters();
  const defaults = { visibilityTimeout: 30, messageRetentionPeriod: 345600, delaySeconds: 0, receiveMessageWaitTimeSeconds: 0, maximumMessageSize: 262144 };
  const ctx: SqsApiContext = {
    host,
    accountId: "acct",
    region: "local-1",
    waiters,
    async createQueue(config) {
      const name = String(config.name);
      return host.upsert({ id: `https://sqs.local-1.amazonaws.com/${ACCOUNT}/${name}`, name, config: { ...defaults, ...config } });
    },
    async updateQueue(q, patch) {
      return host.upsert({ id: q.id, name: q.name, config: { ...q.config, ...patch } });
    },
    async deleteQueue(q) {
      host.remove(q.name);
    },
    urlOf: (q) => `http://localhost:4566/${ACCOUNT}/${q.name}`,
  };
  const call = (op: string, body: unknown) => sqsApi(op, body, ctx) as Promise<Record<string, unknown>>;
  return { host, call, waiters, dir };
}

const url = (name: string) => `http://localhost:4566/${ACCOUNT}/${name}`;

describe("SQS on My computer (local)", () => {
  it("creates, finds, lists and describes queues like SQS", async () => {
    const { call } = setup();
    expect(await call("CreateQueue", { QueueName: "orders", Attributes: { VisibilityTimeout: "45" } })).toEqual({ QueueUrl: url("orders") });
    // The same name with the same attributes is fine; with different ones it's an error.
    expect(await call("CreateQueue", { QueueName: "orders", Attributes: { VisibilityTimeout: "45" } })).toEqual({ QueueUrl: url("orders") });
    await expect(call("CreateQueue", { QueueName: "orders", Attributes: { VisibilityTimeout: "60" } })).rejects.toMatchObject({ code: "QueueAlreadyExists" });
    await expect(call("CreateQueue", { QueueName: "jobs", Attributes: { FifoQueue: "true" } })).rejects.toMatchObject({ code: "InvalidAttributeName" });
    await call("CreateQueue", { QueueName: "orders-dlq" });
    expect(await call("GetQueueUrl", { QueueName: "orders-dlq" })).toEqual({ QueueUrl: url("orders-dlq") });
    expect(await call("ListQueues", { QueueNamePrefix: "ord", MaxResults: 1 })).toMatchObject({ QueueUrls: [url("orders")], NextToken: expect.any(String) });
    const attrs = (await call("GetQueueAttributes", { QueueUrl: url("orders"), AttributeNames: ["All"] })).Attributes as Record<string, string>;
    expect(attrs).toMatchObject({ VisibilityTimeout: "45", ApproximateNumberOfMessages: "0", QueueArn: `arn:aws:sqs:local-1:${ACCOUNT}:orders` });
    await expect(call("GetQueueUrl", { QueueName: "nope" })).rejects.toMatchObject({ code: "AWS.SimpleQueueService.NonExistentQueue" });
  });

  it("sends, receives, hides and deletes messages", async () => {
    const { call } = setup();
    await call("CreateQueue", { QueueName: "q" });
    const sent = await call("SendMessage", { QueueUrl: url("q"), MessageBody: "hello", MessageAttributes: { kind: { DataType: "String", StringValue: "greeting" } } });
    expect(sent).toMatchObject({ MessageId: expect.any(String), MD5OfMessageBody: "5d41402abc4b2a76b9719d911017c592", MD5OfMessageAttributes: expect.any(String) });
    const got = (await call("ReceiveMessage", { QueueUrl: url("q"), MessageAttributeNames: ["All"], AttributeNames: ["ApproximateReceiveCount"] })).Messages as Record<string, unknown>[];
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ Body: "hello", MessageAttributes: { kind: { StringValue: "greeting", DataType: "String" } }, Attributes: { ApproximateReceiveCount: "1" } });
    // Hidden while in flight.
    expect(await call("ReceiveMessage", { QueueUrl: url("q") })).toEqual({});
    await call("ChangeMessageVisibility", { QueueUrl: url("q"), ReceiptHandle: got[0].ReceiptHandle, VisibilityTimeout: 0 });
    const again = (await call("ReceiveMessage", { QueueUrl: url("q") })).Messages as { ReceiptHandle: string }[];
    expect(again).toHaveLength(1);
    await call("DeleteMessage", { QueueUrl: url("q"), ReceiptHandle: again[0].ReceiptHandle });
    expect((await call("GetQueueAttributes", { QueueUrl: url("q"), AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] })).Attributes).toEqual({
      ApproximateNumberOfMessages: "0",
      ApproximateNumberOfMessagesNotVisible: "0",
    });
  });

  it("handles batches entry by entry", async () => {
    const { call } = setup();
    await call("CreateQueue", { QueueName: "q" });
    const r = await call("SendMessageBatch", { QueueUrl: url("q"), Entries: [{ Id: "a", MessageBody: "one" }, { Id: "b", MessageBody: "two" }, { Id: "c", MessageBody: "" }] });
    expect((r.Successful as { Id: string }[]).map((s) => s.Id)).toEqual(["a", "b"]);
    expect(r.Failed).toEqual([{ Id: "c", SenderFault: true, Code: "MissingParameter", Message: expect.any(String) }]);
    await expect(call("SendMessageBatch", { QueueUrl: url("q"), Entries: [{ Id: "x", MessageBody: "1" }, { Id: "x", MessageBody: "2" }] })).rejects.toMatchObject({ code: "AWS.SimpleQueueService.BatchEntryIdsNotDistinct" });
    await expect(call("SendMessageBatch", { QueueUrl: url("q"), Entries: Array.from({ length: 11 }, (_, i) => ({ Id: `m${i}`, MessageBody: "x" })) })).rejects.toMatchObject({
      code: "AWS.SimpleQueueService.TooManyEntriesInBatchRequest",
    });
    const msgs = (await call("ReceiveMessage", { QueueUrl: url("q"), MaxNumberOfMessages: 10 })).Messages as { ReceiptHandle: string }[];
    const del = await call("DeleteMessageBatch", { QueueUrl: url("q"), Entries: [...msgs.map((m, i) => ({ Id: `d${i}`, ReceiptHandle: m.ReceiptHandle })), { Id: "bad", ReceiptHandle: "x" }] });
    expect((del.Successful as unknown[]).length).toBe(2);
    expect(del.Failed).toEqual([expect.objectContaining({ Id: "bad", Code: "ReceiptHandleIsInvalid" })]);
  });

  it("long-polls: a waiting receive returns as soon as a message is sent, and waits no longer than asked", async () => {
    const { call, waiters } = setup();
    await call("CreateQueue", { QueueName: "q" });
    const started = Date.now();
    const pending = call("ReceiveMessage", { QueueUrl: url("q"), WaitTimeSeconds: 5 });
    await new Promise((r) => setTimeout(r, 100));
    expect(waiters.count()).toBe(1);
    await call("SendMessage", { QueueUrl: url("q"), MessageBody: "wake up" });
    const r = (await pending).Messages as { Body: string }[];
    expect(r[0].Body).toBe("wake up");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(waiters.count()).toBe(0);

    const t0 = Date.now();
    expect(await call("ReceiveMessage", { QueueUrl: url("q"), WaitTimeSeconds: 1 })).toEqual({});
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  });

  it("long-polls until a delayed message becomes visible", async () => {
    const { call } = setup();
    await call("CreateQueue", { QueueName: "q" });
    await call("SendMessage", { QueueUrl: url("q"), MessageBody: "later", DelaySeconds: 1 });
    const t0 = Date.now();
    const r = (await call("ReceiveMessage", { QueueUrl: url("q"), WaitTimeSeconds: 5 })).Messages as { Body: string }[];
    expect(r[0].Body).toBe("later");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("moves a message that keeps failing to the dead-letter queue", async () => {
    const { call } = setup();
    await call("CreateQueue", { QueueName: "dlq" });
    const dlqArn = ((await call("GetQueueAttributes", { QueueUrl: url("dlq"), AttributeNames: ["QueueArn"] })).Attributes as Record<string, string>).QueueArn;
    await call("CreateQueue", { QueueName: "work", Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 2 }), VisibilityTimeout: "0" } });
    await call("SendMessage", { QueueUrl: url("work"), MessageBody: "poison" });
    for (let i = 0; i < 2; i++) expect((await call("ReceiveMessage", { QueueUrl: url("work") })).Messages).toHaveLength(1);
    expect(await call("ReceiveMessage", { QueueUrl: url("work") })).toEqual({});
    const moved = (await call("ReceiveMessage", { QueueUrl: url("dlq"), AttributeNames: ["All"] })).Messages as { Body: string; Attributes: Record<string, string> }[];
    expect(moved[0]).toMatchObject({ Body: "poison", Attributes: { DeadLetterQueueSourceArn: `arn:aws:sqs:local-1:${ACCOUNT}:work` } });
    expect(await call("ListDeadLetterSourceQueues", { QueueUrl: url("dlq") })).toEqual({ queueUrls: [url("work")] });
  });

  it("keeps messages through a restart, and purges once a minute", async () => {
    const { call, host, dir } = setup();
    await call("CreateQueue", { QueueName: "q" });
    await call("SendMessage", { QueueUrl: url("q"), MessageBody: "kept" });
    host.flush();
    const again = setup(dir);
    expect(((await again.call("ReceiveMessage", { QueueUrl: url("q") })).Messages as { Body: string }[])[0].Body).toBe("kept");
    await again.call("PurgeQueue", { QueueUrl: url("q") });
    await expect(again.call("PurgeQueue", { QueueUrl: url("q") })).rejects.toMatchObject({ code: "AWS.SimpleQueueService.PurgeQueueInProgress" });
    await expect(again.call("CreateQueueX", {})).rejects.toBeInstanceOf(EngineError);
  });
});
