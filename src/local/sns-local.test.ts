import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { snsApi, snsErrorXml, snsResponseXml, type Params, type SnsApiContext } from "@/engine/sns/api";
import { subscriptionConfirmation } from "@/engine/sns/publish";
import { sqsApi, type SqsApiContext } from "@/engine/sqs/api";
import { FileSubscriptionHost, FileTopicHost, LocalHosts } from "./sns-host";
import { FileQueueHost } from "./sqs-host";

const ACCOUNT = "123456789012";

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "cl-sns-"));
  const topics = new FileTopicHost(path.join(dir, "topics"));
  const subs = new FileSubscriptionHost(path.join(dir, "subs"));
  const queues = new FileQueueHost(path.join(dir, "queues"));
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  let answer = 200;
  const hosts = new LocalHosts([topics, subs, queues], () => new Date(), async (url, headers, body) => {
    posts.push({ url, headers, body });
    return { status: answer };
  }, "http://localhost:4566");

  // What CloudLab's server does with these calls, in miniature.
  const ctx: SnsApiContext = {
    host: hosts,
    accountId: "acct",
    region: "local-1",
    createTopic: async (c) => topics.upsert({ id: `arn:aws:sns:local-1:${ACCOUNT}:${c.name}`, name: String(c.name), config: c }),
    updateTopic: async (t, patch) => topics.upsert({ id: t.id, name: t.name, config: { ...t.config, ...patch } }),
    deleteTopic: async (t) => topics.remove(t.name),
    subscribe: async (c) =>
      subs.upsert({
        id: `${c.topicArn}:${randomUUID()}`,
        name: `${c.protocol}: ${c.endpoint}`,
        config: c,
        state: c.protocol === "sqs" ? "confirmed" : "pending-confirmation",
        attributes: { token: "tok-" + String(c.endpoint).length, inbox: [] },
      }),
    updateSubscription: async (s, patch) => subs.upsert({ id: s.id, name: s.name, config: { ...s.config, ...patch } }),
    unsubscribe: async (s) => subs.remove(s.name),
    confirm: async (_topicArn, token) => {
      const s = (await hosts.list("acct", { service: "sns", type: "subscription" })).find((x) => x.attributes.token === token);
      if (!s) throw new Error("bad token");
      return subs.upsert({ id: s.id, name: s.name, config: s.config, state: "confirmed" });
    },
  };
  const call = async (params: Record<string, string>) => (await snsApi(new Map(Object.entries(params)) as Params, ctx)).result as Record<string, unknown>;

  const qctx: SqsApiContext = {
    host: hosts,
    accountId: "acct",
    region: "local-1",
    createQueue: async (c) =>
      queues.upsert({ id: `https://sqs.local-1.amazonaws.com/${ACCOUNT}/${c.name}`, name: String(c.name), config: { visibilityTimeout: 30, messageRetentionPeriod: 345600, delaySeconds: 0, receiveMessageWaitTimeSeconds: 0, maximumMessageSize: 262144, ...c } }),
    updateQueue: async (q, patch) => queues.upsert({ id: q.id, name: q.name, config: { ...q.config, ...patch } }),
    deleteQueue: async (q) => queues.remove(q.name),
    urlOf: (q) => `http://localhost:4566/${ACCOUNT}/${q.name}`,
  };
  const sqs = (op: string, body: unknown) => sqsApi(op, body, qctx) as Promise<Record<string, unknown>>;
  return { call, sqs, posts, topics, setAnswer: (n: number) => (answer = n) };
}

const TOPIC = `arn:aws:sns:local-1:${ACCOUNT}:orders`;

describe("SNS on My computer (local)", () => {
  it("creates, lists and describes topics", async () => {
    const { call } = setup();
    expect(await call({ Action: "CreateTopic", Name: "orders", "Attributes.entry.1.key": "DisplayName", "Attributes.entry.1.value": "Orders" })).toEqual({ TopicArn: TOPIC });
    expect(await call({ Action: "CreateTopic", Name: "orders" })).toEqual({ TopicArn: TOPIC });
    await expect(call({ Action: "CreateTopic", Name: "x.fifo" })).rejects.toMatchObject({ code: "InvalidParameter" });
    expect(await call({ Action: "ListTopics" })).toEqual({ Topics: [{ TopicArn: TOPIC }] });
    const attrs = (await call({ Action: "GetTopicAttributes", TopicArn: TOPIC })).Attributes as { entries: Record<string, string> };
    expect(attrs.entries).toMatchObject({ DisplayName: "Orders", Owner: ACCOUNT, SubscriptionsConfirmed: "0" });
    await expect(call({ Action: "GetTopicAttributes", TopicArn: TOPIC + "x" })).rejects.toMatchObject({ code: "NotFound", status: 404 });
    // Deleting a topic that doesn't exist is fine.
    expect(await call({ Action: "DeleteTopic", TopicArn: TOPIC + "x" })).toEqual({});
  });

  it("fans out to SQS queues whose policy lets the topic send, with filters and raw delivery", async () => {
    const { call, sqs } = setup();
    await call({ Action: "CreateTopic", Name: "orders" });
    const policy = (name: string) =>
      JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: `arn:aws:sqs:local-1:${ACCOUNT}:${name}`, Condition: { ArnEquals: { "aws:SourceArn": TOPIC } } }] });
    for (const name of ["all", "big", "closed"]) await sqs("CreateQueue", { QueueName: name, Attributes: name === "closed" ? {} : { Policy: policy(name) } });
    const sub = (name: string, extra: Record<string, string> = {}) =>
      call({ Action: "Subscribe", TopicArn: TOPIC, Protocol: "sqs", Endpoint: `arn:aws:sqs:local-1:${ACCOUNT}:${name}`, ReturnSubscriptionArn: "true", ...extra });
    await sub("all", { "Attributes.entry.1.key": "RawMessageDelivery", "Attributes.entry.1.value": "true" });
    await sub("big", { "Attributes.entry.1.key": "FilterPolicy", "Attributes.entry.1.value": JSON.stringify({ amount: [{ numeric: [">", 100] }] }) });
    await sub("closed");

    for (const amount of ["50", "500"]) {
      const r = await call({ Action: "Publish", TopicArn: TOPIC, Message: `order of ${amount}`, "MessageAttributes.entry.1.Name": "amount", "MessageAttributes.entry.1.Value.DataType": "Number", "MessageAttributes.entry.1.Value.StringValue": amount });
      expect(r.MessageId).toEqual(expect.any(String));
    }
    const bodies = async (q: string) => (((await sqs("ReceiveMessage", { QueueUrl: `http://localhost:4566/${ACCOUNT}/${q}`, MaxNumberOfMessages: 10 })).Messages as { Body: string }[] | undefined) ?? []).map((m) => m.Body);
    expect(await bodies("all")).toEqual(["order of 50", "order of 500"]);
    const big = await bodies("big");
    expect(big).toHaveLength(1);
    expect(JSON.parse(big[0])).toMatchObject({ Type: "Notification", TopicArn: TOPIC, Message: "order of 500", MessageAttributes: { amount: { Type: "Number", Value: "500" } } });
    // No policy, no messages: SNS records why.
    expect(await bodies("closed")).toEqual([]);
  });

  it("POSTs to HTTP endpoints once they confirm, and records how each delivery went", async () => {
    const { call, posts, setAnswer, topics } = setup();
    await call({ Action: "CreateTopic", Name: "orders" });
    expect(await call({ Action: "Subscribe", TopicArn: TOPIC, Protocol: "http", Endpoint: "http://localhost:3000/sns" })).toEqual({ SubscriptionArn: "pending confirmation" });
    // Not confirmed: nothing is sent.
    await call({ Action: "Publish", TopicArn: TOPIC, Message: "too early" });
    expect(posts).toHaveLength(0);

    const subs = (await call({ Action: "ListSubscriptionsByTopic", TopicArn: TOPIC })).Subscriptions as { SubscriptionArn: string }[];
    expect(subs[0].SubscriptionArn).toBe("PendingConfirmation");
    await call({ Action: "ConfirmSubscription", TopicArn: TOPIC, Token: "tok-" + "http://localhost:3000/sns".length });

    await call({ Action: "Publish", TopicArn: TOPIC, Message: "hello app", Subject: "Hi" });
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("http://localhost:3000/sns");
    expect(posts[0].headers).toMatchObject({ "x-amz-sns-message-type": "Notification", "x-amz-sns-topic-arn": TOPIC });
    expect(JSON.parse(posts[0].body)).toMatchObject({ Type: "Notification", Message: "hello app", Subject: "Hi", UnsubscribeURL: expect.stringMatching(/^http:\/\/localhost:4566\/\?Action=Unsubscribe&SubscriptionArn=/) });

    // An app that keeps failing: SNS tries 3 times, then records the failure.
    setAnswer(500);
    const { MessageId } = await call({ Action: "Publish", TopicArn: TOPIC, Message: "will fail" });
    await new Promise((r) => setTimeout(r, 4_300));
    expect(posts.filter((p) => JSON.parse(p.body).Message === "will fail")).toHaveLength(3);
    const deliveries = topics.byName("orders").attributes.deliveries as { messageId: string; status: string; reason?: string }[];
    expect(deliveries.find((d) => d.messageId === MessageId)).toMatchObject({ status: "failed", reason: expect.stringContaining("HTTP 500") });
    expect(deliveries.find((d) => d.status === "delivered")).toBeTruthy();
  }, 10_000);

  it("builds AWS's SubscriptionConfirmation and XML answers", () => {
    const sub = { id: `${TOPIC}:abc`, attributes: { token: "t0k" } } as never;
    const { headers, body } = subscriptionConfirmation(TOPIC, sub, "http://localhost:4566", "2026-10-13T00:00:00.000Z");
    expect(headers["x-amz-sns-message-type"]).toBe("SubscriptionConfirmation");
    expect(JSON.parse(body)).toMatchObject({ Type: "SubscriptionConfirmation", Token: "t0k", SubscribeURL: `http://localhost:4566/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=t0k` });
    expect(snsResponseXml("Publish", { MessageId: "m-1" }, "r-1")).toContain("<PublishResponse xmlns=\"http://sns.amazonaws.com/doc/2010-03-31/\"><PublishResult><MessageId>m-1</MessageId></PublishResult>");
    expect(snsResponseXml("ListTopics", { Topics: [{ TopicArn: "a&b" }] }, "r")).toContain("<Topics><member><TopicArn>a&amp;b</TopicArn></member></Topics>");
    expect(snsErrorXml("NotFound", "Topic does not exist", 404, "r")).toContain("<Error><Type>Sender</Type><Code>NotFound</Code><Message>Topic does not exist</Message></Error>");
  });

  it("publishes batches entry by entry", async () => {
    const { call } = setup();
    await call({ Action: "CreateTopic", Name: "orders" });
    const r = await call({
      Action: "PublishBatch",
      TopicArn: TOPIC,
      "PublishBatchRequestEntries.member.1.Id": "a",
      "PublishBatchRequestEntries.member.1.Message": "one",
      "PublishBatchRequestEntries.member.2.Id": "b",
      "PublishBatchRequestEntries.member.2.Message": "",
    });
    expect((r.Successful as { Id: string }[]).map((x) => x.Id)).toEqual(["a"]);
    expect(r.Failed).toEqual([expect.objectContaining({ Id: "b", Code: "InvalidParameter" })]);
  });
});
