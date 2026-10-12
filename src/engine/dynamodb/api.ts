import { EngineError } from "../errors";
import { describeTable, tableKey } from "../services/dynamodb";
import type { Resource } from "../types";
import type { TableHost } from "./host";
import { checkItemCondition, deleteItem, getItem, putItem, query, scan, updateItem } from "./items";
import { executeStatement } from "./partiql";
import { validation, type AttributeValue, type Item } from "./values";

/**
 * DynamoDB's own API (the JSON protocol the AWS SDKs and the AWS CLI speak:
 * POST / with X-Amz-Target: DynamoDB_20120810.<Operation>). Requests and
 * responses are AWS's shapes; the work is done by the same item code as the
 * console. Tables are created, changed and deleted through the context, so
 * CloudLab knows about them too.
 */

export interface DynamoApiContext {
  host: TableHost;
  accountId: string;
  region: string;
  createTable(config: Record<string, unknown>): Promise<Resource>;
  updateTable(t: Resource, patch: Record<string, unknown>): Promise<Resource>;
  deleteTable(t: Resource): Promise<void>;
}

type Body = Record<string, unknown>;
type Names = Record<string, string> | undefined;
type Values = Record<string, AttributeValue> | undefined;

const invalid = (m: string) => validation(`One or more parameter values were invalid: ${m}`);
const missing = (_param: string, path: string) => validation(`1 validation error detected: Value null at '${path}' failed to satisfy constraint: Member must not be null`);

function str(body: Body, param: string, path = param.charAt(0).toLowerCase() + param.slice(1)): string {
  const v = body[param];
  if (typeof v !== "string" || !v) throw missing(param, path);
  return v;
}

const unsupported = (what: string) => validation(`CloudLab doesn't support ${what} yet. Use expression parameters (KeyConditionExpression, FilterExpression, ConditionExpression, UpdateExpression, ProjectionExpression) instead.`);

function refuseLegacy(body: Body) {
  for (const [p, alt] of [
    ["KeyConditions", "KeyConditionExpression"],
    ["QueryFilter", "FilterExpression"],
    ["ScanFilter", "FilterExpression"],
    ["Expected", "ConditionExpression"],
    ["AttributeUpdates", "UpdateExpression"],
    ["AttributesToGet", "ProjectionExpression"],
  ]) {
    if (body[p] !== undefined) throw unsupported(`the legacy parameter ${p} (use ${alt})`);
  }
}

async function tables(ctx: DynamoApiContext) {
  return ctx.host.list(ctx.accountId, { service: "dynamodb", type: "table", region: ctx.region });
}

async function table(ctx: DynamoApiContext, nameOrArn: string): Promise<Resource> {
  const t = (await tables(ctx)).find((x) => x.name === nameOrArn || x.id === nameOrArn);
  if (!t) throw new EngineError("ResourceNotFoundException", `Requested resource not found: Table: ${nameOrArn} not found`, 400);
  return t;
}

const expr = (body: Body) => ({ names: body.ExpressionAttributeNames as Names, values: body.ExpressionAttributeValues as Values });

// ---------- tables ----------

/** On the wire, the JSON protocol sends times as seconds since 1970 (the CLI shows them as dates). */
const epoch = (iso: unknown) => (typeof iso === "string" ? Date.parse(iso) / 1000 : iso);
function wire(t: Resource, status?: string) {
  const d = describeTable(t, status) as Record<string, unknown>;
  const billing = d.BillingModeSummary as Record<string, unknown> | undefined;
  return {
    ...d,
    CreationDateTime: epoch(d.CreationDateTime),
    ...(billing ? { BillingModeSummary: { ...billing, LastUpdateToPayPerRequestDateTime: epoch(billing.LastUpdateToPayPerRequestDateTime) } } : {}),
  };
}

interface KeyElement {
  AttributeName?: string;
  KeyType?: string;
}
interface GsiInput {
  IndexName?: string;
  KeySchema?: KeyElement[];
  Projection?: { ProjectionType?: string };
  ProvisionedThroughput?: { ReadCapacityUnits?: number; WriteCapacityUnits?: number };
}

function keyOf(schema: KeyElement[] | undefined, where: string) {
  const hash = (schema ?? []).filter((k) => k.KeyType === "HASH");
  const range = (schema ?? []).filter((k) => k.KeyType === "RANGE");
  if (!schema?.length || hash.length !== 1 || range.length > 1 || hash.length + range.length !== schema.length || schema[0].KeyType !== "HASH") {
    throw invalid(`Invalid KeySchema${where}: The first KeySchemaElement is not a HASH key type`);
  }
  return { pk: hash[0].AttributeName ?? "", sk: range[0]?.AttributeName };
}

function createTableConfig(body: Body): Record<string, unknown> {
  const name = str(body, "TableName");
  const defs = (body.AttributeDefinitions as { AttributeName?: string; AttributeType?: string }[] | undefined) ?? [];
  if (!defs.length) throw missing("AttributeDefinitions", "attributeDefinitions");
  if (!body.KeySchema) throw missing("KeySchema", "keySchema");
  const types = new Map<string, string>();
  defs.forEach((d, i) => {
    if (!["S", "N", "B"].includes(String(d.AttributeType))) {
      throw validation(`1 validation error detected: Value '${d.AttributeType}' at 'attributeDefinitions.${i + 1}.member.attributeType' failed to satisfy constraint: Member must satisfy enum value set: [B, N, S]`);
    }
    types.set(String(d.AttributeName), String(d.AttributeType));
  });
  if (body.LocalSecondaryIndexes !== undefined) throw validation("CloudLab doesn't support local secondary indexes yet. Use a global secondary index.");
  const { pk, sk } = keyOf(body.KeySchema as KeyElement[], "");
  const gsis = (body.GlobalSecondaryIndexes as GsiInput[] | undefined) ?? [];
  const gsiKeys = gsis.map((g) => {
    if (!g.IndexName) throw missing("IndexName", "globalSecondaryIndexes.1.member.indexName");
    if (g.Projection?.ProjectionType && g.Projection.ProjectionType !== "ALL") throw validation("CloudLab's global secondary indexes project ALL attributes. Use Projection: { ProjectionType: 'ALL' }.");
    return { name: g.IndexName, ...keyOf(g.KeySchema, ` for index ${g.IndexName}`) };
  });
  const used = new Set([pk, ...(sk ? [sk] : []), ...gsiKeys.flatMap((g) => [g.pk, ...(g.sk ? [g.sk] : [])])]);
  for (const k of used) {
    if (!types.has(k)) throw invalid(`Some index key attributes are not defined in AttributeDefinitions. Keys: [${k}], AttributeDefinitions: [${[...types.keys()].join(", ")}]`);
  }
  if (used.size !== types.size) throw invalid("Number of attributes in KeySchema does not exactly match number of attributes defined in AttributeDefinitions");
  const billing = String(body.BillingMode ?? "PROVISIONED");
  if (!["PROVISIONED", "PAY_PER_REQUEST"].includes(billing)) {
    throw validation(`1 validation error detected: Value '${billing}' at 'billingMode' failed to satisfy constraint: Member must satisfy enum value set: [PROVISIONED, PAY_PER_REQUEST]`);
  }
  const tp = body.ProvisionedThroughput as { ReadCapacityUnits?: number; WriteCapacityUnits?: number } | undefined;
  if (billing === "PROVISIONED" && (!tp?.ReadCapacityUnits || !tp?.WriteCapacityUnits)) throw invalid("ReadCapacityUnits and WriteCapacityUnits must both be specified when BillingMode is PROVISIONED");
  if (billing === "PAY_PER_REQUEST" && tp) throw invalid("Neither ReadCapacityUnits nor WriteCapacityUnits can be specified when BillingMode is PAY_PER_REQUEST");
  return {
    name,
    partitionKey: pk,
    partitionKeyType: types.get(pk),
    ...(sk ? { sortKey: sk, sortKeyType: types.get(sk) } : {}),
    billingMode: billing,
    ...(billing === "PROVISIONED" ? { readCapacity: Number(tp!.ReadCapacityUnits), writeCapacity: Number(tp!.WriteCapacityUnits) } : {}),
    globalSecondaryIndexes: gsiKeys.map((g) => ({
      indexName: g.name,
      partitionKey: g.pk,
      partitionKeyType: types.get(g.pk),
      ...(g.sk ? { sortKey: g.sk, sortKeyType: types.get(g.sk) } : {}),
    })),
    deletionProtection: body.DeletionProtectionEnabled === true,
  };
}

async function updateTableInput(ctx: DynamoApiContext, body: Body) {
  const t = await table(ctx, str(body, "TableName"));
  const patch: Record<string, unknown> = {};
  if (body.BillingMode !== undefined) patch.billingMode = body.BillingMode;
  const tp = body.ProvisionedThroughput as { ReadCapacityUnits?: number; WriteCapacityUnits?: number } | undefined;
  if (tp) {
    if ((patch.billingMode ?? t.config.billingMode) === "PAY_PER_REQUEST") throw invalid("Neither ReadCapacityUnits nor WriteCapacityUnits can be specified when BillingMode is PAY_PER_REQUEST");
    patch.readCapacity = Number(tp.ReadCapacityUnits);
    patch.writeCapacity = Number(tp.WriteCapacityUnits);
  } else if (patch.billingMode === "PROVISIONED" && t.config.billingMode !== "PROVISIONED") {
    throw invalid("ProvisionedThroughput must be specified when BillingMode is PROVISIONED");
  }
  if (body.DeletionProtectionEnabled !== undefined) patch.deletionProtection = body.DeletionProtectionEnabled === true;
  const updates = (body.GlobalSecondaryIndexUpdates as { Create?: GsiInput; Delete?: { IndexName?: string }; Update?: unknown }[] | undefined) ?? [];
  if (updates.length) {
    const defs = new Map(((body.AttributeDefinitions as { AttributeName: string; AttributeType: string }[] | undefined) ?? []).map((d) => [d.AttributeName, d.AttributeType]));
    let gsis = [...((t.config.globalSecondaryIndexes as Record<string, unknown>[] | undefined) ?? [])];
    for (const u of updates) {
      if (u.Create) {
        const g = u.Create;
        if (!g.IndexName) throw missing("IndexName", "globalSecondaryIndexUpdates.1.member.create.indexName");
        if (gsis.some((x) => x.indexName === g.IndexName)) throw invalid(`Attempting to create an index which already exists: ${g.IndexName}`);
        const { pk, sk } = keyOf(g.KeySchema, ` for index ${g.IndexName}`);
        const typeOf = (k: string) => {
          const v = defs.get(k);
          if (!v) throw invalid(`Some index key attributes are not defined in AttributeDefinitions. Keys: [${k}], AttributeDefinitions: [${[...defs.keys()].join(", ")}]`);
          return v;
        };
        gsis.push({ indexName: g.IndexName, partitionKey: pk, partitionKeyType: typeOf(pk), ...(sk ? { sortKey: sk, sortKeyType: typeOf(sk) } : {}) });
      } else if (u.Delete) {
        if (!gsis.some((x) => x.indexName === u.Delete!.IndexName)) throw new EngineError("ResourceNotFoundException", `Requested resource not found: Index: ${u.Delete.IndexName} not found`, 400);
        gsis = gsis.filter((x) => x.indexName !== u.Delete!.IndexName);
      } else if (u.Update) {
        // Provisioned throughput per index: CloudLab's indexes share the table's.
      }
    }
    patch.globalSecondaryIndexes = gsis;
  }
  if (body.StreamSpecification !== undefined) throw validation("CloudLab doesn't support DynamoDB Streams yet.");
  if (!Object.keys(patch).length) throw validation("At least one of ProvisionedThroughput, BillingMode, UpdateStreamEnabled, GlobalSecondaryIndexUpdates or SSESpecification or ReplicaUpdates is required");
  return { t, patch };
}

// ---------- operations ----------

type Handler = (ctx: DynamoApiContext, body: Body) => Promise<unknown>;

const MAX_BATCH_WRITE = 25;
const MAX_BATCH_GET = 100;
const MAX_TRANSACT = 100;

const ops: Record<string, Handler> = {
  async CreateTable(ctx, body) {
    if (body.StreamSpecification && (body.StreamSpecification as { StreamEnabled?: boolean }).StreamEnabled) throw validation("CloudLab doesn't support DynamoDB Streams yet.");
    const t = await ctx.createTable(createTableConfig(body));
    return { TableDescription: wire(t, "CREATING") };
  },

  async DescribeTable(ctx, body) {
    return { Table: wire(await table(ctx, str(body, "TableName"))) };
  },

  async ListTables(ctx, body) {
    const names = (await tables(ctx)).map((t) => t.name).sort();
    const after = body.ExclusiveStartTableName ? String(body.ExclusiveStartTableName) : null;
    const limit = body.Limit === undefined ? 100 : Number(body.Limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw validation(`1 validation error detected: Value '${body.Limit}' at 'limit' failed to satisfy constraint: Member must have value less than or equal to 100`);
    const rest = after ? names.filter((n) => n > after) : names;
    const page = rest.slice(0, limit);
    return { TableNames: page, ...(rest.length > limit ? { LastEvaluatedTableName: page[page.length - 1] } : {}) };
  },

  async UpdateTable(ctx, body) {
    const { t, patch } = await updateTableInput(ctx, body);
    const updated = await ctx.updateTable(t, patch);
    return { TableDescription: wire(updated) };
  },

  async DeleteTable(ctx, body) {
    const t = await table(ctx, str(body, "TableName"));
    await ctx.deleteTable(t);
    return { TableDescription: wire(t, "DELETING") };
  },

  async DescribeTimeToLive(ctx, body) {
    const t = await table(ctx, str(body, "TableName"));
    return { TimeToLiveDescription: t.config.ttlAttribute ? { TimeToLiveStatus: "ENABLED", AttributeName: t.config.ttlAttribute } : { TimeToLiveStatus: "DISABLED" } };
  },

  async UpdateTimeToLive(ctx, body) {
    const t = await table(ctx, str(body, "TableName"));
    const spec = body.TimeToLiveSpecification as { Enabled?: boolean; AttributeName?: string } | undefined;
    if (!spec || typeof spec.Enabled !== "boolean" || !spec.AttributeName) throw missing("TimeToLiveSpecification", "timeToLiveSpecification");
    if (spec.Enabled && t.config.ttlAttribute) throw validation("TimeToLive is already enabled");
    if (!spec.Enabled && !t.config.ttlAttribute) throw validation("TimeToLive is already disabled");
    if (!spec.Enabled && t.config.ttlAttribute !== spec.AttributeName) throw validation(`TimeToLive is active on a different AttributeName: current AttributeName is ${t.config.ttlAttribute}`);
    await ctx.updateTable(t, { ttlAttribute: spec.Enabled ? spec.AttributeName : null });
    return { TimeToLiveSpecification: { Enabled: spec.Enabled, AttributeName: spec.AttributeName } };
  },

  async PutItem(ctx, body) {
    refuseLegacy(body);
    const t = await table(ctx, str(body, "TableName"));
    return putItem(ctx.host, t, body.Item, { ...expr(body), condition: body.ConditionExpression as string | undefined, returnValues: body.ReturnValues as string | undefined });
  },

  async GetItem(ctx, body) {
    refuseLegacy(body);
    const t = await table(ctx, str(body, "TableName"));
    if (body.Key === undefined) throw missing("Key", "key");
    return getItem(ctx.host, t, body.Key, { ...expr(body), projection: body.ProjectionExpression as string | undefined, consistentRead: body.ConsistentRead === true });
  },

  async UpdateItem(ctx, body) {
    refuseLegacy(body);
    const t = await table(ctx, str(body, "TableName"));
    if (body.Key === undefined) throw missing("Key", "key");
    if (!body.UpdateExpression) throw validation("CloudLab needs an UpdateExpression for UpdateItem (for example SET #n = :v).");
    return updateItem(ctx.host, t, body.Key, {
      ...expr(body),
      update: String(body.UpdateExpression),
      condition: body.ConditionExpression as string | undefined,
      returnValues: body.ReturnValues as string | undefined,
    });
  },

  async DeleteItem(ctx, body) {
    refuseLegacy(body);
    const t = await table(ctx, str(body, "TableName"));
    if (body.Key === undefined) throw missing("Key", "key");
    return deleteItem(ctx.host, t, body.Key, { ...expr(body), condition: body.ConditionExpression as string | undefined, returnValues: body.ReturnValues as string | undefined });
  },

  async Query(ctx, body) {
    refuseLegacy(body);
    const t = await table(ctx, str(body, "TableName"));
    return query(ctx.host, t, {
      ...expr(body),
      keyCondition: String(body.KeyConditionExpression ?? ""),
      filter: body.FilterExpression as string | undefined,
      projection: body.ProjectionExpression as string | undefined,
      indexName: body.IndexName as string | undefined,
      scanIndexForward: body.ScanIndexForward !== false,
      limit: body.Limit as number | undefined,
      exclusiveStartKey: body.ExclusiveStartKey as Item | undefined,
      select: body.Select as string | undefined,
      consistentRead: body.ConsistentRead === true,
    });
  },

  async Scan(ctx, body) {
    refuseLegacy(body);
    const t = await table(ctx, str(body, "TableName"));
    const total = body.TotalSegments as number | undefined;
    const segment = body.Segment as number | undefined;
    if ((total === undefined) !== (segment === undefined)) throw validation("The TotalSegments parameter is required but was not present in the request when Segment parameter is present");
    // A parallel scan: CloudLab's tables are small, so segment 0 reads everything and the others are empty.
    if (total !== undefined && segment! > 0) return { Items: [], Count: 0, ScannedCount: 0 };
    return scan(ctx.host, t, {
      ...expr(body),
      filter: body.FilterExpression as string | undefined,
      projection: body.ProjectionExpression as string | undefined,
      indexName: body.IndexName as string | undefined,
      limit: body.Limit as number | undefined,
      exclusiveStartKey: body.ExclusiveStartKey as Item | undefined,
      select: body.Select as string | undefined,
      consistentRead: body.ConsistentRead === true,
    });
  },

  async BatchWriteItem(ctx, body) {
    const req = (body.RequestItems ?? {}) as Record<string, { PutRequest?: { Item: Item }; DeleteRequest?: { Key: Item } }[]>;
    const all = Object.values(req).flat();
    if (!all.length) throw validation("1 validation error detected: Value '{}' at 'requestItems' failed to satisfy constraint: Member must have length greater than or equal to 1");
    if (all.length > MAX_BATCH_WRITE) throw validation(`1 validation error detected: Value at 'requestItems' failed to satisfy constraint: Map value must satisfy constraint: [Member must have length less than or equal to ${MAX_BATCH_WRITE}, Member must have length greater than or equal to 1]`);
    for (const [name, writes] of Object.entries(req)) {
      const t = await table(ctx, name);
      const seen = new Set<string>();
      const key = tableKey(t);
      for (const w of writes) {
        const it = w.PutRequest?.Item ?? w.DeleteRequest?.Key;
        if (!it || (w.PutRequest && w.DeleteRequest)) throw validation("Supplied AttributeValue has more than one datatypes set, must contain exactly one of the supported datatypes");
        const id = JSON.stringify([it[key.partition.name], key.sort ? it[key.sort.name] : null]);
        if (seen.has(id)) throw validation("Provided list of item keys contains duplicates");
        seen.add(id);
      }
      for (const w of writes) {
        if (w.PutRequest) await putItem(ctx.host, t, w.PutRequest.Item);
        else await deleteItem(ctx.host, t, w.DeleteRequest!.Key);
      }
    }
    return { UnprocessedItems: {} };
  },

  async BatchGetItem(ctx, body) {
    const req = (body.RequestItems ?? {}) as Record<string, { Keys: Item[]; ProjectionExpression?: string; ExpressionAttributeNames?: Names; ConsistentRead?: boolean }>;
    const count = Object.values(req).reduce((n, r) => n + (r.Keys?.length ?? 0), 0);
    if (!count) throw validation("1 validation error detected: Value '{}' at 'requestItems' failed to satisfy constraint: Member must have length greater than or equal to 1");
    if (count > MAX_BATCH_GET) throw validation("Too many items requested for the BatchGetItem call");
    const responses: Record<string, Item[]> = {};
    for (const [name, r] of Object.entries(req)) {
      const t = await table(ctx, name);
      responses[name] = [];
      for (const k of r.Keys) {
        const got = await getItem(ctx.host, t, k, { names: r.ExpressionAttributeNames, projection: r.ProjectionExpression, consistentRead: r.ConsistentRead === true });
        if (got.Item) responses[name].push(got.Item);
      }
    }
    return { Responses: responses, UnprocessedKeys: {} };
  },

  async TransactWriteItems(ctx, body) {
    type Op = { TableName: string; Key?: Item; Item?: Item; ConditionExpression?: string; UpdateExpression?: string; ExpressionAttributeNames?: Names; ExpressionAttributeValues?: Values };
    const list = (body.TransactItems ?? []) as { Put?: Op; Update?: Op; Delete?: Op; ConditionCheck?: Op }[];
    if (!list.length || list.length > MAX_TRANSACT) throw validation(`1 validation error detected: Value at 'transactItems' failed to satisfy constraint: Member must have length less than or equal to ${MAX_TRANSACT}`);
    const steps = await Promise.all(
      list.map(async (x) => {
        const kind = (["Put", "Update", "Delete", "ConditionCheck"] as const).find((k) => x[k]);
        if (!kind) throw validation("TransactItems can only contain one of Check, Put, Update or Delete");
        const op = x[kind]!;
        return { kind, op, t: await table(ctx, op.TableName) };
      }),
    );
    // One operation per item.
    const seen = new Set<string>();
    for (const s of steps) {
      const key = tableKey(s.t);
      const it = s.op.Key ?? s.op.Item ?? {};
      const id = `${s.t.id}|${JSON.stringify([it[key.partition.name], key.sort ? it[key.sort.name] : null])}`;
      if (seen.has(id)) throw validation("Transaction request cannot include multiple operations on one item");
      seen.add(id);
    }
    // All or nothing: keep each table as it was, put it back if any step fails.
    const before = new Map<string, Resource>();
    for (const s of steps) if (!before.has(s.t.id)) before.set(s.t.id, await ctx.host.get(s.t.accountId, s.t.id));
    const reasons: { Code: string; Message?: string }[] = steps.map(() => ({ Code: "None" }));
    let failed = false;
    for (const [i, s] of steps.entries()) {
      const e = { names: s.op.ExpressionAttributeNames, values: s.op.ExpressionAttributeValues };
      try {
        if (s.kind === "Put") await putItem(ctx.host, s.t, s.op.Item, { ...e, condition: s.op.ConditionExpression });
        else if (s.kind === "Delete") await deleteItem(ctx.host, s.t, s.op.Key, { ...e, condition: s.op.ConditionExpression });
        else if (s.kind === "Update") await updateItem(ctx.host, s.t, s.op.Key, { ...e, update: String(s.op.UpdateExpression ?? ""), condition: s.op.ConditionExpression });
        else {
          if (!s.op.ConditionExpression) throw missing("ConditionExpression", `transactItems.${i + 1}.member.conditionCheck.conditionExpression`);
          await checkItemCondition(ctx.host, s.t, s.op.Key, { ...e, condition: s.op.ConditionExpression });
        }
      } catch (err) {
        if (!(err instanceof EngineError)) throw err;
        if (err.code !== "ConditionalCheckFailedException") {
          await restore(ctx.host, before);
          throw err;
        }
        reasons[i] = { Code: "ConditionalCheckFailed", Message: "The conditional request failed" };
        failed = true;
      }
    }
    if (failed) {
      await restore(ctx.host, before);
      const e = new EngineError(
        "TransactionCanceledException",
        `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.map((r) => r.Code).join(", ")}]`,
        400,
      );
      (e as EngineError & { extra?: unknown }).extra = { CancellationReasons: reasons };
      throw e;
    }
    return {};
  },

  async TransactGetItems(ctx, body) {
    const list = (body.TransactItems ?? []) as { Get?: { TableName: string; Key: Item; ProjectionExpression?: string; ExpressionAttributeNames?: Names } }[];
    if (!list.length || list.length > MAX_TRANSACT) throw validation(`1 validation error detected: Value at 'transactItems' failed to satisfy constraint: Member must have length less than or equal to ${MAX_TRANSACT}`);
    const out = [];
    for (const x of list) {
      if (!x.Get) throw validation("TransactItems can only contain Get");
      const t = await table(ctx, x.Get.TableName);
      const r = await getItem(ctx.host, t, x.Get.Key, { names: x.Get.ExpressionAttributeNames, projection: x.Get.ProjectionExpression, consistentRead: true });
      out.push(r.Item ? { Item: r.Item } : {});
    }
    return { Responses: out };
  },

  async ExecuteStatement(ctx, body) {
    const r = await executeStatement(ctx.host, ctx.accountId, ctx.region, str(body, "Statement"), (body.Parameters as AttributeValue[] | undefined) ?? []);
    return { Items: r.Items ?? [] };
  },

  async BatchExecuteStatement(ctx, body) {
    const list = (body.Statements ?? []) as { Statement: string; Parameters?: AttributeValue[] }[];
    if (!list.length || list.length > 25) throw validation("1 validation error detected: Value at 'statements' failed to satisfy constraint: Member must have length less than or equal to 25");
    const out = [];
    for (const s of list) {
      try {
        const r = await executeStatement(ctx.host, ctx.accountId, ctx.region, s.Statement, s.Parameters ?? []);
        out.push(r.Items?.[0] ? { Item: r.Items[0] } : {});
      } catch (e) {
        if (!(e instanceof EngineError)) throw e;
        out.push({ Error: { Code: e.code.replace(/Exception$/, ""), Message: e.message } });
      }
    }
    return { Responses: out };
  },

  async DescribeLimits() {
    return { AccountMaxReadCapacityUnits: 80000, AccountMaxWriteCapacityUnits: 80000, TableMaxReadCapacityUnits: 40000, TableMaxWriteCapacityUnits: 40000 };
  },

  async DescribeEndpoints() {
    return { Endpoints: [] };
  },

  async ListTagsOfResource() {
    return { Tags: [] };
  },
};

async function restore(host: TableHost, before: Map<string, Resource>) {
  for (const t of before.values()) {
    const { items, itemCount, tableSizeBytes, stats } = t.attributes;
    await host.setAttributes(t.accountId, t.id, { items, itemCount, tableSizeBytes, stats });
  }
}

export const DYNAMODB_OPERATIONS = Object.keys(ops);

/** Runs one DynamoDB API call: the operation (from X-Amz-Target) and its JSON body. */
export async function dynamodbApi(operation: string, body: unknown, ctx: DynamoApiContext): Promise<unknown> {
  const handler = ops[operation];
  if (!handler) throw new EngineError("UnknownOperationException", operation ? `CloudLab's DynamoDB doesn't support ${operation} yet.` : "", 400);
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Body) : {};
  return handler(ctx, b);
}
