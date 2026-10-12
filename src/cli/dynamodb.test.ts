import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";

let clock: Date;
let engine: Engine;
const ACCOUNT = "acct-ddb-cli";
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

const CREATE =
  "aws dynamodb create-table --table-name Orders --attribute-definitions AttributeName=customerId,AttributeType=S AttributeName=orderDate,AttributeType=S --key-schema AttributeName=customerId,KeyType=HASH AttributeName=orderDate,KeyType=RANGE --billing-mode PAY_PER_REQUEST";
const put = (c: string, d: string, extra = "") => json(`aws dynamodb put-item --table-name Orders --item '{"customerId":{"S":"${c}"},"orderDate":{"S":"${d}"}${extra}}'`);

beforeEach(async () => {
  clock = new Date("2026-10-01T12:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("aws dynamodb", { timeout: 30_000 }, () => {
  it("creates tables and explains the classic mistakes", async () => {
    expect(await fails("aws dynamodb create-table --table-name Orders --attribute-definitions AttributeName=customerId,AttributeType=S AttributeName=status,AttributeType=S --key-schema AttributeName=customerId,KeyType=HASH --billing-mode PAY_PER_REQUEST")).toEqual({
      code: "ValidationException",
      message: "One or more parameter values were invalid: Number of attributes in KeySchema does not exactly match number of attributes defined in AttributeDefinitions",
    });
    expect(await fails("aws dynamodb create-table --table-name Orders --attribute-definitions AttributeName=customerId,AttributeType=S --key-schema AttributeName=customerId,KeyType=HASH")).toMatchObject({
      message: "One or more parameter values were invalid: ReadCapacityUnits and WriteCapacityUnits must both be specified when BillingMode is PROVISIONED",
    });
    const created = (await json(CREATE)).TableDescription;
    expect(created).toMatchObject({ TableName: "Orders", TableStatus: "CREATING", KeySchema: [{ AttributeName: "customerId", KeyType: "HASH" }, { AttributeName: "orderDate", KeyType: "RANGE" }] });
    expect(await fails(CREATE)).toEqual({ code: "ResourceInUseException", message: "Table already exists: Orders" });
    // Not ACTIVE yet.
    expect(await fails(`aws dynamodb put-item --table-name Orders --item '{"customerId":{"S":"a"},"orderDate":{"S":"1"}}'`)).toMatchObject({ code: "ResourceNotFoundException" });
    advance(3);
    expect((await json("aws dynamodb describe-table --table-name Orders")).Table.TableStatus).toBe("ACTIVE");
    expect(await fails("aws dynamodb describe-table --table-name Nope")).toEqual({ code: "ResourceNotFoundException", message: "Requested resource not found: Table: Nope not found" });
    expect(await json("aws dynamodb list-tables")).toEqual({ TableNames: ["Orders"] });
  });

  it("puts, gets, updates and deletes items with DynamoDB's errors", async () => {
    await json(CREATE);
    advance(3);
    await put("asha", "2026-10-01", ',"total":{"N":"499"},"status":{"S":"placed"}');
    expect(await fails(`aws dynamodb put-item --table-name Orders --item '{"customerId":{"S":"asha"}}'`)).toEqual({
      code: "ValidationException",
      message: "One or more parameter values were invalid: Missing the key orderDate in the item",
    });
    expect(await fails(`aws dynamodb put-item --table-name Orders --item '{"customerId":{"N":"1"},"orderDate":{"S":"x"}}'`)).toMatchObject({
      message: "One or more parameter values were invalid: Type mismatch for key customerId expected: S actual: N",
    });
    expect(await fails(`aws dynamodb get-item --table-name Orders --key '{"customerId":{"S":"asha"}}'`)).toEqual({ code: "ValidationException", message: "The provided key element does not match the schema" });
    const got = await json(`aws dynamodb get-item --table-name Orders --key '{"customerId":{"S":"asha"},"orderDate":{"S":"2026-10-01"}}'`);
    expect(got.Item.total).toEqual({ N: "499" });
    // A missing item: nothing printed.
    expect((await run(`aws dynamodb get-item --table-name Orders --key '{"customerId":{"S":"nobody"},"orderDate":{"S":"x"}}'`)).output).toBe("");

    // Conditional put: don't overwrite.
    expect(await fails(`aws dynamodb put-item --table-name Orders --item '{"customerId":{"S":"asha"},"orderDate":{"S":"2026-10-01"}}' --condition-expression "attribute_not_exists(customerId)"`)).toEqual({
      code: "ConditionalCheckFailedException",
      message: "The conditional request failed",
    });
    // Reserved words need #names.
    expect(await fails(`aws dynamodb update-item --table-name Orders --key '{"customerId":{"S":"asha"},"orderDate":{"S":"2026-10-01"}}' --update-expression "SET status = :s" --expression-attribute-values '{":s":{"S":"shipped"}}'`)).toEqual({
      code: "ValidationException",
      message: "Invalid UpdateExpression: Attribute name is a reserved keyword; reserved keyword: status",
    });
    expect(await fails(`aws dynamodb update-item --table-name Orders --key '{"customerId":{"S":"asha"},"orderDate":{"S":"2026-10-01"}}' --update-expression "SET #s = :s" --expression-attribute-names '{"#s":"status"}' --expression-attribute-values '{":s":{"S":"shipped"},":x":{"S":"y"}}'`)).toEqual({
      code: "ValidationException",
      message: "Value provided in ExpressionAttributeValues unused in expressions: keys: {:x}",
    });
    const upd = await json(
      `aws dynamodb update-item --table-name Orders --key '{"customerId":{"S":"asha"},"orderDate":{"S":"2026-10-01"}}' --update-expression "SET #s = :s ADD visits :one REMOVE #t" --expression-attribute-names '{"#s":"status","#t":"total"}' --expression-attribute-values '{":s":{"S":"shipped"},":one":{"N":"1"}}' --return-values ALL_NEW`,
    );
    expect(upd.Attributes).toEqual({ customerId: { S: "asha" }, orderDate: { S: "2026-10-01" }, status: { S: "shipped" }, visits: { N: "1" } });
    expect(await fails(`aws dynamodb update-item --table-name Orders --key '{"customerId":{"S":"asha"},"orderDate":{"S":"2026-10-01"}}' --update-expression "SET customerId = :c" --expression-attribute-values '{":c":{"S":"z"}}'`)).toMatchObject({
      message: "One or more parameter values were invalid: Cannot update attribute customerId. This attribute is part of the key",
    });
    const del = await json(`aws dynamodb delete-item --table-name Orders --key '{"customerId":{"S":"asha"},"orderDate":{"S":"2026-10-01"}}' --return-values ALL_OLD`);
    expect(del.Attributes.status).toEqual({ S: "shipped" });
    expect((await json("aws dynamodb describe-table --table-name Orders")).Table.ItemCount).toBe(0);
  });

  it("queries a partition by sort key range, scans with filters, and queries a GSI", async () => {
    await json(CREATE);
    advance(3);
    await put("asha", "2026-09-01", ',"status":{"S":"delivered"},"total":{"N":"100"}');
    await put("asha", "2026-10-01", ',"status":{"S":"placed"},"total":{"N":"499"}');
    await put("asha", "2026-10-05", ',"status":{"S":"placed"},"total":{"N":"50"}');
    await put("ravi", "2026-10-02", ',"status":{"S":"placed"},"total":{"N":"999"}');

    const q = await json(
      `aws dynamodb query --table-name Orders --key-condition-expression "customerId = :c AND orderDate >= :from" --expression-attribute-values '{":c":{"S":"asha"},":from":{"S":"2026-10-01"}}'`,
    );
    expect(q.Items.map((i: { orderDate: { S: string } }) => i.orderDate.S)).toEqual(["2026-10-01", "2026-10-05"]);
    expect(q).toMatchObject({ Count: 2, ScannedCount: 2 });
    const newest = await json(`aws dynamodb query --table-name Orders --key-condition-expression "customerId = :c" --expression-attribute-values '{":c":{"S":"asha"}}' --no-scan-index-forward --limit 1`);
    expect(newest.Items[0].orderDate.S).toBe("2026-10-05");
    expect(newest.LastEvaluatedKey).toEqual({ customerId: { S: "asha" }, orderDate: { S: "2026-10-05" } });
    expect(await fails(`aws dynamodb query --table-name Orders --key-condition-expression "orderDate = :d" --expression-attribute-values '{":d":{"S":"2026-10-01"}}'`)).toEqual({
      code: "ValidationException",
      message: "Query condition missed key schema element: customerId",
    });
    expect(await fails(`aws dynamodb query --table-name Orders --key-condition-expression "customerId = :c AND #t > :t" --expression-attribute-names '{"#t":"total"}' --expression-attribute-values '{":c":{"S":"asha"},":t":{"N":"1"}}'`)).toMatchObject({
      message: "Query key condition not supported",
    });
    // "total" is a reserved word: plain names in expressions must not be.
    expect(await fails(`aws dynamodb scan --table-name Orders --filter-expression "total > :t" --expression-attribute-values '{":t":{"N":"200"}}'`)).toMatchObject({
      message: "Invalid FilterExpression: Attribute name is a reserved keyword; reserved keyword: total",
    });

    // A filter runs after the read: ScannedCount counts everything read.
    const scan = await json(`aws dynamodb scan --table-name Orders --filter-expression "#t > :t" --expression-attribute-names '{"#t":"total"}' --expression-attribute-values '{":t":{"N":"200"}}'`);
    expect(scan).toMatchObject({ Count: 2, ScannedCount: 4 });
    expect(await json(`aws dynamodb scan --table-name Orders --select COUNT`)).toMatchObject({ Count: 4 });

    await json(
      `aws dynamodb update-table --table-name Orders --attribute-definitions AttributeName=status,AttributeType=S AttributeName=orderDate,AttributeType=S --global-secondary-index-updates '[{"Create":{"IndexName":"by-status","KeySchema":[{"AttributeName":"status","KeyType":"HASH"},{"AttributeName":"orderDate","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}}]'`,
    );
    const placed = await json(
      `aws dynamodb query --table-name Orders --index-name by-status --key-condition-expression "#s = :s" --expression-attribute-names '{"#s":"status"}' --expression-attribute-values '{":s":{"S":"placed"}}'`,
    );
    expect(placed.Items.map((i: { customerId: { S: string } }) => i.customerId.S)).toEqual(["asha", "ravi", "asha"]);
    expect(await fails(`aws dynamodb query --table-name Orders --index-name nope --key-condition-expression "customerId = :c" --expression-attribute-values '{":c":{"S":"a"}}'`)).toMatchObject({
      message: "The table does not have the specified index: nope",
    });
  });

  it("throttles a provisioned table and expires items by TTL", async () => {
    await json(
      "aws dynamodb create-table --table-name Tiny --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=2",
    );
    advance(3);
    const p = (id: number) => run(`aws dynamodb put-item --table-name Tiny --item '{"id":{"S":"${id}"},"exp":{"N":"${Math.floor(clock.getTime() / 1000) + 60}"}}'`);
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await p(i)).exitCode);
    expect(results.filter((c) => c !== 0).length).toBeGreaterThan(0);
    expect(await fails(`aws dynamodb put-item --table-name Tiny --item '{"id":{"S":"x"}}'`)).toMatchObject({ code: "ProvisionedThroughputExceededException" });

    await json("aws dynamodb update-time-to-live --table-name Tiny --time-to-live-specification Enabled=true,AttributeName=exp");
    advance(120);
    expect((await json("aws dynamodb scan --table-name Tiny")).Count).toBe(0);
    await json("aws dynamodb update-table --table-name Tiny --deletion-protection-enabled");
    expect(await fails("aws dynamodb delete-table --table-name Tiny")).toMatchObject({ message: "Resource cannot be deleted as it is currently protected against deletion. Disable deletion protection first." });
  });
});
