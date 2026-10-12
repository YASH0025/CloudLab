import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dynamodbApi, type DynamoApiContext } from "@/engine/dynamodb/api";
import { explore } from "@/engine/dynamodb/explore";
import { EngineError } from "@/engine/errors";
import { FileTableHost } from "./dynamodb-host";

function setup(dir = mkdtempSync(path.join(tmpdir(), "cl-ddb-"))) {
  const changed: string[] = [];
  const host = new FileTableHost(dir, (t) => changed.push(t.name));
  const ctx: DynamoApiContext = {
    host,
    accountId: "acct",
    region: "local-1",
    async createTable(config) {
      if (host.has(String(config.name))) throw new EngineError("ResourceInUseException", `Table already exists: ${config.name}`);
      return host.upsert({ id: `arn:aws:dynamodb:local-1:123456789012:table/${config.name}`, name: String(config.name), config });
    },
    async updateTable(t, patch) {
      return host.upsert({ id: t.id, name: t.name, config: { ...t.config, ...patch } });
    },
    async deleteTable(t) {
      host.remove(t.name);
    },
  };
  const call = (op: string, body: unknown) => dynamodbApi(op, body, ctx) as Promise<Record<string, unknown>>;
  return { host, ctx, call, dir, changed };
}

const orders = {
  TableName: "Orders",
  AttributeDefinitions: [
    { AttributeName: "customer", AttributeType: "S" },
    { AttributeName: "orderId", AttributeType: "N" },
    { AttributeName: "status", AttributeType: "S" },
  ],
  KeySchema: [
    { AttributeName: "customer", KeyType: "HASH" },
    { AttributeName: "orderId", KeyType: "RANGE" },
  ],
  GlobalSecondaryIndexes: [{ IndexName: "by-status", KeySchema: [{ AttributeName: "status", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }],
  BillingMode: "PAY_PER_REQUEST",
};

const order = (customer: string, orderId: number, status: string, total: number) => ({
  customer: { S: customer },
  orderId: { N: String(orderId) },
  status: { S: status },
  amount: { N: String(total) },
});

describe("DynamoDB on My computer (local)", () => {
  it("creates tables with DynamoDB's checks, and describes and lists them", async () => {
    const { call } = setup();
    const created = await call("CreateTable", orders);
    expect(created.TableDescription).toMatchObject({ TableName: "Orders", TableStatus: "CREATING", KeySchema: orders.KeySchema });
    await expect(call("CreateTable", { ...orders, TableName: "Bad", BillingMode: undefined })).rejects.toMatchObject({
      code: "ValidationException",
      message: expect.stringContaining("ReadCapacityUnits and WriteCapacityUnits must both be specified"),
    });
    await expect(call("CreateTable", { ...orders, TableName: "Bad2", AttributeDefinitions: orders.AttributeDefinitions.slice(0, 2) })).rejects.toMatchObject({
      message: expect.stringContaining("not defined in AttributeDefinitions"),
    });
    const d = await call("DescribeTable", { TableName: "Orders" });
    expect(d.Table).toMatchObject({ TableStatus: "ACTIVE", ItemCount: 0, GlobalSecondaryIndexes: [expect.objectContaining({ IndexName: "by-status" })] });
    await expect(call("DescribeTable", { TableName: "Nope" })).rejects.toMatchObject({ code: "ResourceNotFoundException" });
    for (const n of ["Alpha", "Beta"]) await call("CreateTable", { ...orders, TableName: n, GlobalSecondaryIndexes: undefined, AttributeDefinitions: orders.AttributeDefinitions.slice(0, 2) });
    expect(await call("ListTables", { Limit: 2 })).toEqual({ TableNames: ["Alpha", "Beta"], LastEvaluatedTableName: "Beta" });
    expect(await call("ListTables", { ExclusiveStartTableName: "Beta" })).toEqual({ TableNames: ["Orders"] });
  });

  it("writes, reads, updates and deletes items, with conditions and return values", async () => {
    const { call, changed } = setup();
    await call("CreateTable", orders);
    expect(await call("PutItem", { TableName: "Orders", Item: order("ana", 1, "NEW", 20) })).toEqual({});
    expect(changed).toContain("Orders");
    await expect(call("PutItem", { TableName: "Orders", Item: order("ana", 1, "NEW", 20), ConditionExpression: "attribute_not_exists(customer)" })).rejects.toMatchObject({
      code: "ConditionalCheckFailedException",
    });
    await expect(call("PutItem", { TableName: "Orders", Item: { customer: { S: "ana" } } })).rejects.toMatchObject({ message: expect.stringContaining("Missing the key orderId") });

    const got = await call("GetItem", { TableName: "Orders", Key: { customer: { S: "ana" }, orderId: { N: "1" } }, ProjectionExpression: "#s", ExpressionAttributeNames: { "#s": "status" } });
    expect(got).toEqual({ Item: { status: { S: "NEW" } } });

    const up = await call("UpdateItem", {
      TableName: "Orders",
      Key: { customer: { S: "ana" }, orderId: { N: "1" } },
      UpdateExpression: "SET amount = amount + :inc, #s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":inc": { N: "5" }, ":s": { S: "PAID" } },
      ReturnValues: "UPDATED_NEW",
    });
    expect(up).toEqual({ Attributes: { amount: { N: "25" }, status: { S: "PAID" } } });
    const del = await call("DeleteItem", { TableName: "Orders", Key: { customer: { S: "ana" }, orderId: { N: "1" } }, ReturnValues: "ALL_OLD" });
    expect(del.Attributes).toMatchObject({ amount: { N: "25" } });
    await expect(call("GetItem", { TableName: "Orders", Key: { customer: { S: "ana" } } })).rejects.toMatchObject({ message: "The provided key element does not match the schema" });
  });

  it("queries, scans and pages like DynamoDB, on the table and on an index", async () => {
    const { call } = setup();
    await call("CreateTable", orders);
    await call("BatchWriteItem", {
      RequestItems: { Orders: [1, 2, 3, 4].map((i) => ({ PutRequest: { Item: order(i < 4 ? "ana" : "raj", i, i % 2 ? "NEW" : "PAID", i * 10) } })) },
    });
    const q = await call("Query", {
      TableName: "Orders",
      KeyConditionExpression: "customer = :c AND orderId >= :from",
      FilterExpression: "amount > :t",
      ExpressionAttributeValues: { ":c": { S: "ana" }, ":from": { N: "1" }, ":t": { N: "10" } },
      ScanIndexForward: false,
    });
    expect(q).toMatchObject({ Count: 2, ScannedCount: 3 });
    expect((q.Items as { orderId: { N: string } }[]).map((i) => i.orderId.N)).toEqual(["3", "2"]);

    const page1 = await call("Query", { TableName: "Orders", KeyConditionExpression: "customer = :c", ExpressionAttributeValues: { ":c": { S: "ana" } }, Limit: 2 });
    expect(page1.LastEvaluatedKey).toEqual({ customer: { S: "ana" }, orderId: { N: "2" } });
    const page2 = await call("Query", { TableName: "Orders", KeyConditionExpression: "customer = :c", ExpressionAttributeValues: { ":c": { S: "ana" } }, ExclusiveStartKey: page1.LastEvaluatedKey });
    expect(page2).toMatchObject({ Count: 1 });

    const byStatus = await call("Query", { TableName: "Orders", IndexName: "by-status", KeyConditionExpression: "#s = :s", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":s": { S: "PAID" } } });
    expect(byStatus.Count).toBe(2);
    expect(await call("Scan", { TableName: "Orders", Select: "COUNT" })).toEqual({ Count: 4, ScannedCount: 4 });
    const batch = await call("BatchGetItem", { RequestItems: { Orders: { Keys: [{ customer: { S: "raj" }, orderId: { N: "4" } }, { customer: { S: "zed" }, orderId: { N: "9" } }] } } });
    expect(batch).toMatchObject({ Responses: { Orders: [expect.objectContaining({ amount: { N: "40" } })] }, UnprocessedKeys: {} });
    const sql = await call("ExecuteStatement", { Statement: `SELECT amount FROM "Orders" WHERE customer = ?`, Parameters: [{ S: "raj" }] });
    expect(sql).toEqual({ Items: [{ amount: { N: "40" } }] });
  });

  it("runs transactions all or nothing", async () => {
    const { call } = setup();
    await call("CreateTable", orders);
    await call("PutItem", { TableName: "Orders", Item: order("ana", 1, "NEW", 20) });
    const failing = call("TransactWriteItems", {
      TransactItems: [
        { Put: { TableName: "Orders", Item: order("ana", 2, "NEW", 5) } },
        { Update: { TableName: "Orders", Key: { customer: { S: "ana" }, orderId: { N: "1" } }, UpdateExpression: "SET amount = :z", ConditionExpression: "#s = :paid", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":z": { N: "0" }, ":paid": { S: "PAID" } } } },
      ],
    });
    await expect(failing).rejects.toMatchObject({ code: "TransactionCanceledException", message: expect.stringContaining("[None, ConditionalCheckFailed]") });
    expect(await call("Scan", { TableName: "Orders", Select: "COUNT" })).toMatchObject({ Count: 1 });
    await call("TransactWriteItems", {
      TransactItems: [
        { Put: { TableName: "Orders", Item: order("ana", 2, "NEW", 5) } },
        { ConditionCheck: { TableName: "Orders", Key: { customer: { S: "ana" }, orderId: { N: "1" } }, ConditionExpression: "attribute_exists(customer)" } },
      ],
    });
    const got = await call("TransactGetItems", { TransactItems: [{ Get: { TableName: "Orders", Key: { customer: { S: "ana" }, orderId: { N: "2" } } } }, { Get: { TableName: "Orders", Key: { customer: { S: "x" }, orderId: { N: "1" } } } }] });
    expect(got.Responses).toEqual([{ Item: order("ana", 2, "NEW", 5) }, {}]);
  });

  it("keeps tables as files that survive a restart, and changes settings without losing items", async () => {
    const { call, dir, host } = setup();
    await call("CreateTable", orders);
    await call("PutItem", { TableName: "Orders", Item: order("ana", 1, "NEW", 20) });
    // Writes are batched: on disk within FLUSH_MS, or at once when the agent stops (flush).
    expect(JSON.parse(readFileSync(path.join(dir, "Orders.json"), "utf8")).attributes.itemCount).toBe(0);
    host.flush();
    expect(JSON.parse(readFileSync(path.join(dir, "Orders.json"), "utf8")).attributes.itemCount).toBe(1);

    const again = setup(dir);
    expect(await again.call("GetItem", { TableName: "Orders", Key: { customer: { S: "ana" }, orderId: { N: "1" } } })).toMatchObject({ Item: { amount: { N: "20" } } });
    await again.call("UpdateTimeToLive", { TableName: "Orders", TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" } });
    expect(await again.call("DescribeTimeToLive", { TableName: "Orders" })).toEqual({ TimeToLiveDescription: { TimeToLiveStatus: "ENABLED", AttributeName: "expiresAt" } });
    await expect(again.call("UpdateTimeToLive", { TableName: "Orders", TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" } })).rejects.toMatchObject({ message: "TimeToLive is already enabled" });
    expect((await again.call("Scan", { TableName: "Orders" })).Count).toBe(1);
    await again.call("DeleteTable", { TableName: "Orders" });
    await expect(again.call("Scan", { TableName: "Orders" })).rejects.toMatchObject({ code: "ResourceNotFoundException" });
  });

  it("leaves the table untouched when a write is refused for CloudLab's size limit", async () => {
    const { call, host } = setup();
    await call("CreateTable", { ...orders, GlobalSecondaryIndexes: undefined, AttributeDefinitions: orders.AttributeDefinitions.slice(0, 2) });
    const big = (i: number) => ({ customer: { S: "big" }, orderId: { N: String(i) }, blob: { S: "x".repeat(390 * 1024) } });
    let refused: unknown = null;
    for (let i = 0; i < 12 && !refused; i++) refused = await call("PutItem", { TableName: "Orders", Item: big(i) }).then(() => null, (e) => e);
    expect(refused).toMatchObject({ code: "LimitExceededException" });
    const t = host.byName("Orders");
    expect(Object.keys(t.attributes.items as object)).toHaveLength(t.attributes.itemCount as number);
    // Scan reads 1 MB per page, like DynamoDB: page through to count them all.
    let counted = 0;
    let start: unknown;
    do {
      const page = await call("Scan", { TableName: "Orders", Select: "COUNT", ...(start ? { ExclusiveStartKey: start } : {}) });
      counted += page.Count as number;
      start = page.LastEvaluatedKey;
    } while (start);
    expect(counted).toBe(t.attributes.itemCount);
  });

  it("explores items for the console, and refuses unknown operations and legacy parameters", async () => {
    const { call, host } = setup();
    await call("CreateTable", orders);
    const t = host.byName("Orders");
    await explore(host, t, { action: "put", item: { customer: "ana", orderId: 7, status: "NEW" }, mustBeNew: true });
    expect(await explore(host, t, { action: "query", partitionValue: "ana", forward: true, limit: 10 })).toMatchObject({ count: 1, items: [{ customer: "ana", orderId: 7 }] });
    await expect(call("CreateBackup", {})).rejects.toMatchObject({ code: "UnknownOperationException" });
    await expect(call("Scan", { TableName: "Orders", ScanFilter: {} })).rejects.toMatchObject({ code: "ValidationException", message: expect.stringContaining("FilterExpression") });
  });
});
