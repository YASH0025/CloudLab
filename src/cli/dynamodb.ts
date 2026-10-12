import { deleteItem, getItem, putItem, query, scan, updateItem, type PageResult } from "@/engine/dynamodb/items";
import { executeStatement } from "@/engine/dynamodb/partiql";
import type { AttributeValue, Item } from "@/engine/dynamodb/values";
import { EngineError } from "@/engine/errors";
import { accountNumber } from "@/engine/ids";
import { indexesOf, tableKey, tableNotFound } from "@/engine/services/dynamodb";
import type { Resource } from "@/engine/types";
import type { Args, CliContext, Command } from "./commands";
import { ClientSideError, LocalPathError, parseShorthand, UsageError } from "./parse";

/**
 * `aws dynamodb`: tables (create, describe, update, delete, time to live)
 * and items (put, get, update, delete, query, scan). Like the real CLI, query
 * and scan fetch every page unless you pass --limit or --exclusive-start-key.
 */

const cmd = (c: Command) => c;
const ddbError = (code: string, message: string) => new EngineError(code, message, 400);
const invalidParam = (m: string) => ddbError("ValidationException", `One or more parameter values were invalid: ${m}`);

const tables = (ctx: CliContext) => ctx.engine.list(ctx.accountId, { service: "dynamodb", type: "table", region: ctx.region });

async function tableByName(ctx: CliContext, name: string): Promise<Resource> {
  const t = (await tables(ctx)).find((x) => x.name === name || x.id === name);
  if (!t) throw tableNotFound(name);
  return t;
}

/** A JSON (or file://) argument; --name '{…}' */
function jsonArg<T = unknown>(ctx: CliContext, args: Args, option: string): T | undefined {
  const raw = args.raw(option).join(" ").trim();
  if (!raw) return undefined;
  let text = raw;
  const m = /^file:\/\/(.+)$/.exec(raw);
  if (m) {
    const data = ctx.files?.[m[1]];
    if (data === undefined) throw new LocalPathError(m[1]);
    text = Buffer.from(data, "base64").toString("utf8");
  }
  if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) {
    throw new ClientSideError(`\nError parsing parameter '--${option}': Expected: '=', received: '${text.trim()[0] ?? ""}' for input:\n${text}\n${"^".padStart(1)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new ClientSideError(`\nError parsing parameter '--${option}': Invalid JSON: ${(e as Error).message}\nJSON received: ${text}`);
  }
}

/** Repeated shorthand values, e.g. --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE (or one JSON list). */
function shorthandList(args: Args, option: string): Record<string, string>[] {
  const raw = args.raw(option);
  if (raw.length === 1 && raw[0].trim().startsWith("[")) {
    try {
      return JSON.parse(raw[0]);
    } catch {
      throw new UsageError(`Error parsing parameter '--${option}': Invalid JSON`);
    }
  }
  return raw.map((r) => parseShorthand(r) as Record<string, string>);
}

function expressionInput(ctx: CliContext, args: Args) {
  return {
    names: jsonArg<Record<string, string>>(ctx, args, "expression-attribute-names"),
    values: jsonArg<Record<string, AttributeValue>>(ctx, args, "expression-attribute-values"),
  };
}

const keyFields = (t: Resource) => {
  const key = tableKey(t);
  return [
    { AttributeName: key.partition.name, KeyType: "HASH" },
    ...(key.sort ? [{ AttributeName: key.sort.name, KeyType: "RANGE" }] : []),
  ];
};

function describe(t: Resource, status?: string) {
  const key = tableKey(t);
  const defs = new Map<string, string>([[key.partition.name, key.partition.type]]);
  if (key.sort) defs.set(key.sort.name, key.sort.type);
  const gsis = indexesOf(t);
  for (const g of gsis) {
    defs.set(g.partition.name, g.partition.type);
    if (g.sort) defs.set(g.sort.name, g.sort.type);
  }
  const provisioned = t.config.billingMode === "PROVISIONED";
  const throughput = { NumberOfDecreasesToday: 0, ReadCapacityUnits: provisioned ? Number(t.config.readCapacity) : 0, WriteCapacityUnits: provisioned ? Number(t.config.writeCapacity) : 0 };
  return {
    AttributeDefinitions: [...defs].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType })),
    TableName: t.name,
    KeySchema: keyFields(t),
    TableStatus: status ?? t.state,
    CreationDateTime: t.createdAt,
    ProvisionedThroughput: throughput,
    TableSizeBytes: Number(t.attributes.tableSizeBytes ?? 0),
    ItemCount: Number(t.attributes.itemCount ?? 0),
    TableArn: t.id,
    TableId: t.attributes.tableId,
    ...(provisioned ? {} : { BillingModeSummary: { BillingMode: "PAY_PER_REQUEST", LastUpdateToPayPerRequestDateTime: t.createdAt } }),
    ...(gsis.length
      ? {
          GlobalSecondaryIndexes: gsis.map((g) => ({
            IndexName: g.name,
            KeySchema: [{ AttributeName: g.partition.name, KeyType: "HASH" }, ...(g.sort ? [{ AttributeName: g.sort.name, KeyType: "RANGE" }] : [])],
            Projection: { ProjectionType: "ALL" },
            IndexStatus: "ACTIVE",
            ProvisionedThroughput: throughput,
            IndexArn: `${t.id}/index/${g.name}`,
          })),
        }
      : {}),
    DeletionProtectionEnabled: t.config.deletionProtection === true,
  };
}

interface GsiInput {
  IndexName?: string;
  KeySchema?: { AttributeName: string; KeyType: string }[];
  Projection?: { ProjectionType?: string };
}

/** create-table's arguments → the table's settings, with DynamoDB's validation messages. */
function tableConfig(ctx: CliContext, args: Args): Record<string, unknown> {
  const defs = shorthandList(args, "attribute-definitions");
  const schema = shorthandList(args, "key-schema");
  if (!defs.length) throw new UsageError("the following arguments are required: --attribute-definitions");
  if (!schema.length) throw new UsageError("the following arguments are required: --key-schema");
  const typeOf = new Map(defs.map((d) => [d.AttributeName, d.AttributeType]));
  for (const d of defs) if (!["S", "N", "B"].includes(d.AttributeType)) throw ddbError("ValidationException", `1 validation error detected: Value '${d.AttributeType}' at 'attributeDefinitions.1.member.attributeType' failed to satisfy constraint: Member must satisfy enum value set: [B, N, S]`);
  const hash = schema.filter((k) => k.KeyType === "HASH");
  const range = schema.filter((k) => k.KeyType === "RANGE");
  if (hash.length !== 1 || range.length > 1 || hash.length + range.length !== schema.length) throw invalidParam("Invalid KeySchema: The first KeySchemaElement is not a HASH key type");
  const gsis = jsonArg<GsiInput[]>(ctx, args, "global-secondary-indexes") ?? [];
  const used = new Set([...schema.map((k) => k.AttributeName), ...gsis.flatMap((g) => (g.KeySchema ?? []).map((k) => k.AttributeName))]);
  for (const k of used) if (!typeOf.has(k)) throw invalidParam("Some index key attributes are not defined in AttributeDefinitions. Keys: [" + k + "], AttributeDefinitions: [" + [...typeOf.keys()].join(", ") + "]");
  if (used.size !== typeOf.size) {
    throw invalidParam("Number of attributes in KeySchema does not exactly match number of attributes defined in AttributeDefinitions");
  }
  const billing = args.one("billing-mode") ?? "PROVISIONED";
  if (!["PROVISIONED", "PAY_PER_REQUEST"].includes(billing)) throw ddbError("ValidationException", `1 validation error detected: Value '${billing}' at 'billingMode' failed to satisfy constraint: Member must satisfy enum value set: [PROVISIONED, PAY_PER_REQUEST]`);
  const tp = args.one("provisioned-throughput") ? (parseShorthand(args.one("provisioned-throughput")!) as Record<string, string>) : null;
  if (billing === "PROVISIONED" && (!tp?.ReadCapacityUnits || !tp?.WriteCapacityUnits)) {
    throw invalidParam("ReadCapacityUnits and WriteCapacityUnits must both be specified when BillingMode is PROVISIONED");
  }
  if (billing === "PAY_PER_REQUEST" && tp) throw invalidParam("Neither ReadCapacityUnits nor WriteCapacityUnits can be specified when BillingMode is PAY_PER_REQUEST");
  const keyOf = (ks: { AttributeName: string; KeyType: string }[] | undefined, kt: string) => ks?.find((k) => k.KeyType === kt)?.AttributeName;
  return {
    name: args.required("table-name"),
    partitionKey: hash[0].AttributeName,
    partitionKeyType: typeOf.get(hash[0].AttributeName),
    sortKey: range[0]?.AttributeName,
    sortKeyType: range[0] ? typeOf.get(range[0].AttributeName) : undefined,
    billingMode: billing,
    ...(tp ? { readCapacity: Number(tp.ReadCapacityUnits), writeCapacity: Number(tp.WriteCapacityUnits) } : {}),
    globalSecondaryIndexes: gsis.map((g) => {
      const pk = keyOf(g.KeySchema, "HASH");
      const sk = keyOf(g.KeySchema, "RANGE");
      if (!g.IndexName || !pk) throw invalidParam("Invalid KeySchema for GlobalSecondaryIndex: the first KeySchemaElement must be a HASH key");
      return { indexName: g.IndexName, partitionKey: pk, partitionKeyType: typeOf.get(pk), sortKey: sk, sortKeyType: sk ? typeOf.get(sk) : undefined };
    }),
    deletionProtection: args.bool("deletion-protection-enabled") === true,
  };
}

/** Like the CLI: keep calling until there are no more pages, adding up the counts. */
async function allPages(args: Args, fetch: (start?: Item) => Promise<PageResult>) {
  if (args.has("limit") || args.has("exclusive-start-key")) return fetch();
  let start: Item | undefined;
  const items: Item[] = [];
  let count = 0;
  let scanned = 0;
  let withItems = false;
  for (let i = 0; i < 100; i++) {
    const r = await fetch(start);
    if (r.Items) {
      withItems = true;
      items.push(...r.Items);
    }
    count += r.Count;
    scanned += r.ScannedCount;
    if (!r.LastEvaluatedKey) break;
    start = r.LastEvaluatedKey;
  }
  return { ...(withItems ? { Items: items } : {}), Count: count, ScannedCount: scanned, ConsumedCapacity: null };
}

/** The CLI prints nothing for an empty response (a missing item, a put without --return-values). */
const emptyAsNothing = <T extends object>(r: T): T | undefined => (Object.keys(r).length ? r : undefined);

const intArg = (args: Args, name: string) => {
  const v = args.one(name);
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new UsageError(`argument --${name}: invalid int value: '${v}'`);
  return Number(v);
};

const requireJson = <T,>(ctx: CliContext, args: Args, option: string): T => {
  const v = jsonArg<T>(ctx, args, option);
  if (v === undefined) throw new UsageError(`the following arguments are required: --${option}`);
  return v;
};

export const DYNAMODB_COMMANDS: Command[] = [
  cmd({
    service: "dynamodb",
    operation: "create-table",
    apiName: "CreateTable",
    summary: "Create a table with a partition key (and optional sort key)",
    usage:
      "--table-name <name> --attribute-definitions AttributeName=<a>,AttributeType=S ... --key-schema AttributeName=<a>,KeyType=HASH [AttributeName=<b>,KeyType=RANGE] --billing-mode PAY_PER_REQUEST | --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 [--global-secondary-indexes <json>] [--deletion-protection-enabled]",
    mutates: true,
    async run(args, ctx) {
      const t = await ctx.engine.create(ctx.accountId, { service: "dynamodb", type: "table", region: ctx.region, config: tableConfig(ctx, args) });
      return { TableDescription: describe(t, "CREATING") };
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "describe-table",
    apiName: "DescribeTable",
    summary: "Show a table's key, capacity, indexes and item count",
    usage: "--table-name <name>",
    mutates: false,
    async run(args, ctx) {
      return { Table: describe(await tableByName(ctx, args.required("table-name"))) };
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "list-tables",
    apiName: "ListTables",
    summary: "List table names",
    mutates: false,
    async run(_args, ctx) {
      return { TableNames: (await tables(ctx)).map((t) => t.name).sort() };
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "delete-table",
    apiName: "DeleteTable",
    summary: "Delete a table and all its items",
    usage: "--table-name <name>",
    mutates: true,
    async run(args, ctx) {
      const t = await tableByName(ctx, args.required("table-name"));
      await ctx.engine.remove(ctx.accountId, t.id);
      return { TableDescription: describe(t, "DELETING") };
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "update-table",
    apiName: "UpdateTable",
    summary: "Change capacity, add or remove a global secondary index, or deletion protection",
    usage: "--table-name <name> [--billing-mode …] [--provisioned-throughput ReadCapacityUnits=n,WriteCapacityUnits=n] [--attribute-definitions AttributeName=<a>,AttributeType=S ...] [--global-secondary-index-updates <json>] [--deletion-protection-enabled | --no-deletion-protection-enabled]",
    mutates: true,
    async run(args, ctx) {
      const t = await tableByName(ctx, args.required("table-name"));
      const patch: Record<string, unknown> = {};
      const billing = args.one("billing-mode");
      if (billing) patch.billingMode = billing;
      const tp = args.one("provisioned-throughput");
      if (tp) {
        const v = parseShorthand(tp) as Record<string, string>;
        patch.readCapacity = Number(v.ReadCapacityUnits);
        patch.writeCapacity = Number(v.WriteCapacityUnits);
        if ((billing ?? t.config.billingMode) === "PAY_PER_REQUEST") throw invalidParam("Neither ReadCapacityUnits nor WriteCapacityUnits can be specified when BillingMode is PAY_PER_REQUEST");
        if (patch.readCapacity === Number(t.config.readCapacity) && patch.writeCapacity === Number(t.config.writeCapacity) && t.config.billingMode === "PROVISIONED") {
          throw ddbError("ValidationException", "The provisioned throughput for the table will not change. The requested value equals the current value. Current ReadCapacityUnits provisioned for the table: " + String(t.config.readCapacity) + ". Requested ReadCapacityUnits: " + String(patch.readCapacity) + ". Current WriteCapacityUnits provisioned for the table: " + String(t.config.writeCapacity) + ". Requested WriteCapacityUnits: " + String(patch.writeCapacity) + ". Refer to the Amazon DynamoDB Developer Guide for current limits and how to request higher limits.");
        }
      }
      if (billing === "PROVISIONED" && !tp && t.config.billingMode !== "PROVISIONED") throw invalidParam("ProvisionedThroughput must be specified when BillingMode is PROVISIONED");
      const updates = jsonArg<{ Create?: GsiInput; Delete?: { IndexName: string } }[]>(ctx, args, "global-secondary-index-updates");
      if (updates) {
        const defs = new Map(shorthandList(args, "attribute-definitions").map((d) => [d.AttributeName, d.AttributeType]));
        let gsis = [...((t.config.globalSecondaryIndexes as Record<string, unknown>[] | undefined) ?? [])];
        if (updates.length !== 1) throw invalidParam("Only one global secondary index can be created or deleted per UpdateTable call");
        for (const u of updates) {
          if (u.Delete) {
            if (!gsis.some((g) => g.indexName === u.Delete!.IndexName)) throw ddbError("ResourceNotFoundException", `Requested resource not found: Index: ${u.Delete.IndexName} not found`);
            gsis = gsis.filter((g) => g.indexName !== u.Delete!.IndexName);
          } else if (u.Create) {
            const pk = u.Create.KeySchema?.find((k) => k.KeyType === "HASH")?.AttributeName;
            const sk = u.Create.KeySchema?.find((k) => k.KeyType === "RANGE")?.AttributeName;
            if (!pk || !u.Create.IndexName) throw invalidParam("Invalid KeySchema for GlobalSecondaryIndex");
            for (const k of [pk, sk].filter(Boolean) as string[]) if (!defs.has(k)) throw invalidParam(`Global Secondary Index key attribute ${k} is not defined in AttributeDefinitions (pass --attribute-definitions)`);
            if (gsis.some((g) => g.indexName === u.Create!.IndexName)) throw ddbError("ValidationException", `Attempting to create an index which already exists`);
            gsis.push({ indexName: u.Create.IndexName, partitionKey: pk, partitionKeyType: defs.get(pk), sortKey: sk, sortKeyType: sk ? defs.get(sk) : undefined });
          }
        }
        patch.globalSecondaryIndexes = gsis;
      }
      const dp = args.bool("deletion-protection-enabled");
      if (dp !== undefined) patch.deletionProtection = dp;
      if (Object.keys(patch).length === 0) throw ddbError("ValidationException", "At least one of ProvisionedThroughput, BillingMode, UpdateStreamEnabled, GlobalSecondaryIndexUpdates or SSESpecification or ReplicaUpdates is required");
      const updated = await ctx.engine.update(ctx.accountId, t.id, patch);
      return { TableDescription: describe(updated) };
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "update-time-to-live",
    apiName: "UpdateTimeToLive",
    summary: "Turn on automatic expiry of items by a timestamp attribute",
    usage: "--table-name <name> --time-to-live-specification Enabled=true,AttributeName=<attr>",
    mutates: true,
    async run(args, ctx) {
      const t = await tableByName(ctx, args.required("table-name"));
      const spec = parseShorthand(args.required("time-to-live-specification")) as Record<string, string>;
      const enabled = String(spec.Enabled) === "true";
      if (!spec.AttributeName) throw ddbError("ValidationException", "1 validation error detected: Value null at 'timeToLiveSpecification.attributeName' failed to satisfy constraint: Member must not be null");
      if (enabled && t.config.ttlAttribute) throw ddbError("ValidationException", "TimeToLive is already enabled");
      if (!enabled && !t.config.ttlAttribute) throw ddbError("ValidationException", "TimeToLive is already disabled");
      await ctx.engine.update(ctx.accountId, t.id, { ttlAttribute: enabled ? spec.AttributeName : undefined });
      return { TimeToLiveSpecification: { Enabled: enabled, AttributeName: spec.AttributeName } };
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "describe-time-to-live",
    apiName: "DescribeTimeToLive",
    summary: "Show whether items expire, and by which attribute",
    usage: "--table-name <name>",
    mutates: false,
    async run(args, ctx) {
      const t = await tableByName(ctx, args.required("table-name"));
      return { TimeToLiveDescription: t.config.ttlAttribute ? { TimeToLiveStatus: "ENABLED", AttributeName: t.config.ttlAttribute } : { TimeToLiveStatus: "DISABLED" } };
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "put-item",
    apiName: "PutItem",
    summary: "Write a whole item (replacing any item with the same key)",
    usage: "--table-name <name> --item '{\"pk\":{\"S\":\"a\"},…}' [--condition-expression <expr>] [--expression-attribute-names <json>] [--expression-attribute-values <json>] [--return-values ALL_OLD]",
    mutates: true,
    async run(args, ctx) {
      const t = await tableByName(ctx, args.required("table-name"));
      return emptyAsNothing(await putItem(ctx.engine, t, requireJson(ctx, args, "item"), { ...expressionInput(ctx, args), condition: args.one("condition-expression"), returnValues: args.one("return-values") }));
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "get-item",
    apiName: "GetItem",
    summary: "Read one item by its full key",
    usage: "--table-name <name> --key '{\"pk\":{\"S\":\"a\"}}' [--projection-expression <attrs>] [--consistent-read | --no-consistent-read] [--expression-attribute-names <json>] [--expression-attribute-values <json>]",
    mutates: false,
    async run(args, ctx) {
      const t = await tableByName(ctx, args.required("table-name"));
      return emptyAsNothing(await getItem(ctx.engine, t, requireJson(ctx, args, "key"), { ...expressionInput(ctx, args), projection: args.one("projection-expression"), consistentRead: args.bool("consistent-read") }));
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "update-item",
    apiName: "UpdateItem",
    summary: "Change some attributes of an item (creating it if needed)",
    usage: "--table-name <name> --key <json> --update-expression 'SET #s = :s ADD visits :one' [--condition-expression <expr>] [--expression-attribute-names <json>] [--expression-attribute-values <json>] [--return-values ALL_NEW]",
    mutates: true,
    async run(args, ctx) {
      const t = await tableByName(ctx, args.required("table-name"));
      const update = args.one("update-expression");
      if (!update) throw ddbError("ValidationException", "Nuvora needs --update-expression (the older --attribute-updates form isn't supported)");
      return emptyAsNothing(await updateItem(ctx.engine, t, requireJson(ctx, args, "key"), { ...expressionInput(ctx, args), update, condition: args.one("condition-expression"), returnValues: args.one("return-values") }));
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "delete-item",
    apiName: "DeleteItem",
    summary: "Delete one item by its full key",
    usage: "--table-name <name> --key <json> [--condition-expression <expr>] [--expression-attribute-names <json>] [--expression-attribute-values <json>] [--return-values ALL_OLD]",
    mutates: true,
    async run(args, ctx) {
      const t = await tableByName(ctx, args.required("table-name"));
      return emptyAsNothing(await deleteItem(ctx.engine, t, requireJson(ctx, args, "key"), { ...expressionInput(ctx, args), condition: args.one("condition-expression"), returnValues: args.one("return-values") }));
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "query",
    apiName: "Query",
    summary: "Read the items of one partition (optionally a sort-key range), from the table or an index",
    usage:
      "--table-name <name> --key-condition-expression 'pk = :v [AND sk > :from]' --expression-attribute-values <json> [--expression-attribute-names <json>] [--index-name <gsi>] [--filter-expression <expr>] [--scan-index-forward | --no-scan-index-forward] [--limit n] [--select COUNT] [--projection-expression <attrs>] [--exclusive-start-key <json>] [--consistent-read]",
    mutates: false,
    async run(args, ctx) {
      const t = await tableByName(ctx, args.required("table-name"));
      const keyCondition = args.one("key-condition-expression");
      if (!keyCondition) throw ddbError("ValidationException", "Either the KeyConditions or KeyConditionExpression parameter must be specified in the request.");
      const exprs = expressionInput(ctx, args);
      return allPages(args, (start) =>
        query(ctx.engine, t, {
          ...exprs,
          keyCondition,
          filter: args.one("filter-expression"),
          indexName: args.one("index-name"),
          scanIndexForward: args.bool("scan-index-forward"),
          limit: intArg(args, "limit"),
          exclusiveStartKey: start ?? jsonArg<Item>(ctx, args, "exclusive-start-key"),
          projection: args.one("projection-expression"),
          consistentRead: args.bool("consistent-read"),
          select: args.one("select"),
        }),
      );
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "scan",
    apiName: "Scan",
    summary: "Read every item in the table (slow and costly on big tables), optionally filtered",
    usage: "--table-name <name> [--filter-expression <expr>] [--expression-attribute-names <json>] [--expression-attribute-values <json>] [--index-name <gsi>] [--limit n] [--select COUNT] [--projection-expression <attrs>] [--exclusive-start-key <json>] [--consistent-read]",
    mutates: false,
    async run(args, ctx) {
      const t = await tableByName(ctx, args.required("table-name"));
      const exprs = expressionInput(ctx, args);
      return allPages(args, (start) =>
        scan(ctx.engine, t, {
          ...exprs,
          filter: args.one("filter-expression"),
          indexName: args.one("index-name"),
          limit: intArg(args, "limit"),
          exclusiveStartKey: start ?? jsonArg<Item>(ctx, args, "exclusive-start-key"),
          projection: args.one("projection-expression"),
          consistentRead: args.bool("consistent-read"),
          select: args.one("select"),
        }),
      );
    },
  }),
  cmd({
    service: "dynamodb",
    operation: "execute-statement",
    apiName: "ExecuteStatement",
    summary: "Run a PartiQL (SQL-like) statement: SELECT, INSERT, UPDATE or DELETE",
    usage: "--statement <partiql, e.g. 'SELECT * FROM \"Orders\" WHERE customerId = ?'> [--parameters <json list of values>]",
    mutates: true,
    permissions(args, ctx) {
      const st = args.one("statement") ?? "";
      const verb = st.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
      const action = { SELECT: "dynamodb:PartiQLSelect", INSERT: "dynamodb:PartiQLInsert", UPDATE: "dynamodb:PartiQLUpdate", DELETE: "dynamodb:PartiQLDelete" }[verb] ?? "dynamodb:PartiQLSelect";
      const m = /(?:FROM|INTO|UPDATE)\s+"?([A-Za-z0-9_.-]+)"?/i.exec(st);
      return [{ action, resource: m ? `arn:aws:dynamodb:${ctx.region}:${accountNumber(ctx.accountId)}:table/${m[1]}` : "*" }];
    },
    async run(args, ctx) {
      const statement = args.one("statement");
      if (statement === undefined) throw new UsageError("the following arguments are required: --statement");
      const params = jsonArg<AttributeValue[]>(ctx, args, "parameters") ?? [];
      const r = await executeStatement(ctx.engine, ctx.accountId, ctx.region, statement, params);
      return { Items: r.Items ?? [] };
    },
  }),
];
