import { randomUUID } from "node:crypto";
import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import type { FieldDef, Resource, ResourceTypeDef, ServiceDef } from "../types";

/**
 * DynamoDB tables. A table is defined by its key: a partition key (and an
 * optional sort key). Items are looked up by that key, or queried by
 * partition, and global secondary indexes add other keys to query by. Items
 * live with the table, server-side (dynamodb/items.ts).
 */

export const tableArn = (region: string, accountId: string, name: string) => `arn:aws:dynamodb:${region}:${accountNumber(accountId)}:table/${name}`;
export const TABLE_ARN = /^arn:aws:dynamodb:[a-z0-9-]+:\d{12}:table\/[a-zA-Z0-9_.-]{3,255}$/;
export const tableNotFound = (name: string) => new EngineError("ResourceNotFoundException", `Requested resource not found: Table: ${name} not found`, 400);

export const KEY_TYPES = [
  { value: "S", label: "String" },
  { value: "N", label: "Number" },
  { value: "B", label: "Binary" },
];

export interface KeyDef {
  partition: { name: string; type: string };
  sort?: { name: string; type: string };
}

export interface IndexDef extends KeyDef {
  name: string;
}

export const tableKey = (t: Resource): KeyDef => ({
  partition: { name: String(t.config.partitionKey), type: String(t.config.partitionKeyType) },
  ...(t.config.sortKey ? { sort: { name: String(t.config.sortKey), type: String(t.config.sortKeyType ?? "S") } } : {}),
});

export const indexesOf = (t: Resource): IndexDef[] =>
  ((t.config.globalSecondaryIndexes as Record<string, unknown>[] | undefined) ?? []).map((g) => ({
    name: String(g.indexName),
    partition: { name: String(g.partitionKey), type: String(g.partitionKeyType ?? "S") },
    ...(g.sortKey ? { sort: { name: String(g.sortKey), type: String(g.sortKeyType ?? "S") } } : {}),
  }));

const NAME = "^[a-zA-Z0-9_.-]+$";

const indexItem: FieldDef[] = [
  { key: "indexName", label: "Index name", type: "string", required: true, minLength: 3, maxLength: 255, pattern: NAME, placeholder: "by-status" },
  { key: "partitionKey", label: "Partition key", type: "string", required: true, maxLength: 255, placeholder: "status" },
  { key: "partitionKeyType", label: "Type", type: "enum", required: true, default: "S", options: KEY_TYPES },
  { key: "sortKey", label: "Sort key (optional)", type: "string", maxLength: 255, placeholder: "createdAt" },
  { key: "sortKeyType", label: "Type", type: "enum", default: "S", options: KEY_TYPES },
];

const table: ResourceTypeDef = {
  service: "dynamodb",
  type: "table",
  label: "Table",
  pluralLabel: "Tables",
  description:
    "A NoSQL table: items (rows) found by their key, in single-digit milliseconds at any size. You design the key around how you'll read the data: the partition key picks the group, the sort key orders items inside it.",
  idPrefix: "table",
  makeId: ({ name, region, accountId }) => tableArn(region, accountId, name),
  idPattern: TABLE_ARN,
  notFoundCode: "ResourceNotFoundException",
  notFoundMessage: (id) => `Requested resource not found: Table: ${id.split("/").pop()} not found`,
  notFoundByNameMessage: (name) => `Requested resource not found: Table: ${name} not found`,
  malformedCode: "ResourceNotFoundException",
  malformedMessage: (id) => `Requested resource not found: Table: ${id} not found`,
  apiNoun: "table",
  privateAttributes: ["items"],
  panelAttributes: ["stats", "throttledAt"],
  fields: [
    {
      key: "name",
      label: "Table name",
      type: "string",
      required: true,
      immutable: true,
      minLength: 3,
      maxLength: 255,
      pattern: NAME,
      patternMessage: "3 to 255 letters, numbers, underscores, hyphens and dots.",
      placeholder: "Orders",
      param: "TableName",
    },
    {
      key: "partitionKey",
      label: "Partition key",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 255,
      placeholder: "customerId",
      param: "KeySchema",
      description: "Every item must have it. Items with the same partition key are stored together and read together by Query. Pick something you always know when reading, with many different values.",
    },
    { key: "partitionKeyType", label: "Partition key type", type: "enum", required: true, immutable: true, default: "S", options: KEY_TYPES, param: "AttributeDefinitions" },
    {
      key: "sortKey",
      label: "Sort key (optional)",
      type: "string",
      immutable: true,
      maxLength: 255,
      placeholder: "orderDate",
      param: "KeySchema",
      description: "Orders items within a partition and lets Query pick a range (between two dates, starting with a prefix…). Partition + sort key together must be unique.",
    },
    { key: "sortKeyType", label: "Sort key type", type: "enum", immutable: true, default: "S", options: KEY_TYPES, param: "AttributeDefinitions" },
    {
      key: "billingMode",
      label: "Capacity mode",
      type: "enum",
      required: true,
      default: "PAY_PER_REQUEST",
      param: "BillingMode",
      options: [
        { value: "PAY_PER_REQUEST", label: "On-demand", hint: "Pay per request, scales by itself" },
        { value: "PROVISIONED", label: "Provisioned", hint: "Reserve reads/writes per second; extra requests are throttled" },
      ],
    },
    {
      key: "readCapacity",
      label: "Read capacity units",
      type: "number",
      min: 1,
      max: 40000,
      default: 5,
      param: "ReadCapacityUnits",
      showWhen: { field: "billingMode", in: ["PROVISIONED"] },
      description: "Strongly consistent reads per second of items up to 4 KB (eventually consistent reads count half).",
    },
    {
      key: "writeCapacity",
      label: "Write capacity units",
      type: "number",
      min: 1,
      max: 40000,
      default: 5,
      param: "WriteCapacityUnits",
      showWhen: { field: "billingMode", in: ["PROVISIONED"] },
      description: "Writes per second of items up to 1 KB.",
    },
    {
      key: "globalSecondaryIndexes",
      label: "Global secondary indexes",
      itemLabel: "index",
      type: "list",
      item: indexItem,
      maxItems: 20,
      param: "GlobalSecondaryIndexes",
      description: "Another key to query by, e.g. status, without scanning the whole table. Items without the index's key attributes simply aren't in the index.",
    },
    {
      key: "ttlAttribute",
      label: "Time to live attribute (optional)",
      type: "string",
      maxLength: 255,
      placeholder: "expiresAt",
      param: "TimeToLiveSpecification",
      description: "A Number attribute holding a Unix time in seconds. Items whose time has passed are deleted for free (on AWS within a few days; in CloudLab when the table is next used).",
    },
    { key: "deletionProtection", label: "Deletion protection", type: "boolean", param: "DeletionProtectionEnabled", description: "When on, the table can't be deleted until you turn it off." },
  ],
  columns: [
    { label: "Partition key", path: "config.partitionKey", mono: true },
    { label: "Sort key", path: "config.sortKey", mono: true },
    { label: "Capacity", path: "config.billingMode" },
    { label: "Items", path: "attributes.itemCount" },
  ],
  lifecycle: { create: { state: "CREATING", settlesTo: "ACTIVE", afterMs: 2_000 } },
  iam: {
    create: "dynamodb:CreateTable",
    read: "dynamodb:DescribeTable",
    update: (changed) => [...(changed.includes("ttlAttribute") ? ["dynamodb:UpdateTimeToLive"] : []), ...(changed.some((c) => c !== "ttlAttribute") ? ["dynamodb:UpdateTable"] : [])],
    delete: "dynamodb:DeleteTable",
    arn: (r) => r.id,
  },
  invalidValue({ field, value }) {
    if (field.key === "name") {
      return new EngineError(
        "ValidationException",
        `1 validation error detected: Value '${value}' at 'tableName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z0-9_.-]+`,
      );
    }
    if (field.key === "readCapacity" || field.key === "writeCapacity") {
      return new EngineError("ValidationException", `One or more parameter values were invalid: ${field.param} must be between 1 and 40000 (CloudLab), got ${String(value)}`);
    }
    return undefined;
  },
  canDelete(r) {
    if (r.state === "CREATING") return new EngineError("ResourceInUseException", `Attempt to change a resource which is still in use: Table is being created: ${r.name}`);
    if (r.config.deletionProtection === true) return new EngineError("ValidationException", "Resource cannot be deleted as it is currently protected against deletion. Disable deletion protection first.");
    return undefined;
  },
  async validate({ config, existing, ctx }) {
    if (!existing && (await ctx.list("dynamodb", "table")).some((t) => t.name === config.name)) {
      throw new EngineError("ResourceInUseException", `Table already exists: ${String(config.name)}`);
    }
    if (config.sortKey && config.sortKey === config.partitionKey) {
      throw new EngineError("ValidationException", "Invalid KeySchema: Some index key attribute have no definition");
    }
    // An attribute used by several keys must have one type everywhere.
    const types = new Map<string, string>([[String(config.partitionKey), String(config.partitionKeyType)]]);
    if (config.sortKey) types.set(String(config.sortKey), String(config.sortKeyType ?? "S"));
    const names = new Set<string>();
    for (const g of (config.globalSecondaryIndexes as Record<string, unknown>[] | undefined) ?? []) {
      const n = String(g.indexName);
      if (names.has(n)) throw new EngineError("ValidationException", `One or more parameter values were invalid: Duplicate index name: ${n}`);
      names.add(n);
      for (const [k, t] of [[g.partitionKey, g.partitionKeyType ?? "S"], ...(g.sortKey ? [[g.sortKey, g.sortKeyType ?? "S"]] : [])] as [string, string][]) {
        const known = types.get(k);
        if (known && known !== t) throw new EngineError("ValidationException", `Cannot have two attributes with the same name: ${k} is both ${known} and ${t}`);
        types.set(k, t);
      }
      if (g.sortKey && g.sortKey === g.partitionKey) throw new EngineError("ValidationException", `Invalid KeySchema: index ${n} uses ${String(g.sortKey)} twice`);
    }
  },
  async derive({ config, existing, ctx }) {
    return {
      ...(existing?.attributes ?? {}),
      arn: tableArn(ctx.region, ctx.accountId, String(config.name)),
      tableId: existing?.attributes.tableId ?? randomUUID(),
      items: existing?.attributes.items ?? {},
      itemCount: existing?.attributes.itemCount ?? 0,
      tableSizeBytes: existing?.attributes.tableSizeBytes ?? 0,
    };
  },
};

export const dynamodbService: ServiceDef = {
  id: "dynamodb",
  label: "DynamoDB",
  modelledOn: "Amazon DynamoDB",
  description: "NoSQL tables: items found by key in milliseconds, with no servers to manage.",
  category: "Database",
  types: [table],
};
