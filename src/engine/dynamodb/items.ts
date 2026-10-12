import type { Engine } from "../engine";
import { EngineError } from "../errors";
import { indexesOf, tableKey, tableNotFound, type KeyDef } from "../services/dynamodb";
import type { Resource } from "../types";
import {
  applyUpdate,
  checkUnused,
  evaluate,
  newContext,
  parseCondition,
  parseKeyCondition,
  parseProjection,
  parseUpdate,
  project,
  sortMatches,
  type ExprContext,
} from "./expressions";
import { checkItem, checkValue, compare, itemSize, typeOf, validation, type AttributeValue, type Item } from "./values";

/**
 * Reading and writing items: PutItem, GetItem, UpdateItem, DeleteItem, Query
 * and Scan, with their validation, conditions, capacity (and throttling for
 * provisioned tables), time to live and metrics.
 */

export const MAX_ITEM_BYTES = 400 * 1024;
/** Nuvora's limits: real tables have none. */
export const MAX_ITEMS = 2_000;
export const MAX_TABLE_BYTES = 4 * 1024 * 1024;
/** Query and Scan stop at 1 MB of data read. */
const PAGE_BYTES = 1024 * 1024;

export interface TableStats {
  reads: number;
  writes: number;
  queries: number;
  scans: number;
  throttled: number;
  conditionalFailures: number;
  /** Queries against a global secondary index. */
  indexQueries: number;
}

export const statsOf = (t: Resource): TableStats => ({ reads: 0, writes: 0, queries: 0, scans: 0, throttled: 0, conditionalFailures: 0, indexQueries: 0, ...((t.attributes.stats as Partial<TableStats> | undefined) ?? {}) });

const itemsOf = (t: Resource) => (t.attributes.items as Record<string, Item> | undefined) ?? {};

/** The storage key of an item: its key attributes, in key order. */
const keyString = (key: KeyDef, item: Item) => JSON.stringify([item[key.partition.name], key.sort ? item[key.sort.name] : null]);

export interface ExpressionInput {
  names?: Record<string, string>;
  values?: Record<string, AttributeValue>;
}

function context(input: ExpressionInput): ExprContext {
  if (input.names && Object.keys(input.names).length === 0) throw validation("ExpressionAttributeNames must not be empty");
  if (input.values && Object.keys(input.values).length === 0) throw validation("ExpressionAttributeValues must not be empty");
  for (const [k, v] of Object.entries(input.values ?? {})) {
    if (!k.startsWith(":")) throw validation(`ExpressionAttributeValues contains invalid key: Syntax error; key: "${k}"`);
    checkValue(v, k);
  }
  for (const k of Object.keys(input.names ?? {})) if (!k.startsWith("#")) throw validation(`ExpressionAttributeNames contains invalid key: Syntax error; key: "${k}"`);
  return newContext(input.names, input.values);
}

/** The table, refusing tables that aren't ACTIVE yet, and dropping items whose time to live has passed. */
async function load(engine: Engine, table: Resource): Promise<Resource> {
  const t = await engine.get(table.accountId, table.id).catch(() => null);
  if (!t) throw tableNotFound(table.name);
  if (t.state === "CREATING") throw new EngineError("ResourceNotFoundException", "Requested resource not found", 400);
  const ttl = t.config.ttlAttribute ? String(t.config.ttlAttribute) : null;
  if (ttl) {
    const now = engine.now().getTime() / 1000;
    const items = itemsOf(t);
    const expired = Object.entries(items).filter(([, it]) => {
      const v = it[ttl];
      return v && "N" in v && Number(v.N) < now && Number(v.N) > now - 5 * 365 * 86400;
    });
    if (expired.length) {
      for (const [k] of expired) delete items[k];
      await save(engine, t, items);
    }
  }
  return engine.get(t.accountId, t.id);
}

async function save(engine: Engine, t: Resource, items: Record<string, Item>, add: Partial<TableStats> = {}) {
  const stats = statsOf(t);
  for (const [k, v] of Object.entries(add)) stats[k as keyof TableStats] += v ?? 0;
  const bytes = Object.values(items).reduce((n, it) => n + itemSize(it), 0);
  await engine.setAttributes(t.accountId, t.id, { items, itemCount: Object.keys(items).length, tableSizeBytes: bytes, stats });
}

async function bump(engine: Engine, t: Resource, add: Partial<TableStats>) {
  const stats = statsOf(t);
  for (const [k, v] of Object.entries(add)) stats[k as keyof TableStats] += v ?? 0;
  await engine.setAttributes(t.accountId, t.id, { stats });
}

/**
 * Capacity: units consumed by a request, recorded as metrics. On a provisioned
 * table, more units in one second than provisioned are throttled.
 */
async function consume(engine: Engine, t: Resource, kind: "read" | "write", units: number) {
  const dims = { TableName: t.name };
  const metric = kind === "read" ? "ConsumedReadCapacityUnits" : "ConsumedWriteCapacityUnits";
  if (t.config.billingMode === "PROVISIONED") {
    const limit = Number(kind === "read" ? t.config.readCapacity : t.config.writeCapacity);
    const used = await engine.countInWindow(`ddb-${kind}:${t.id}`, 1_000);
    // countInWindow counts calls; each call is one unit-ish request in Nuvora's model.
    if (used > limit) {
      await bump(engine, t, { throttled: 1 });
      await engine.setAttributes(t.accountId, t.id, { throttledAt: engine.now().toISOString() });
      await engine.metrics.record(t.accountId, t.region, "AWS/DynamoDB", kind === "read" ? "ReadThrottleEvents" : "WriteThrottleEvents", dims, 1, "Count");
      throw new EngineError(
        "ProvisionedThroughputExceededException",
        "The level of configured provisioned throughput for the table was exceeded. Consider increasing your provisioning level with the UpdateTable API.",
        400,
      );
    }
  }
  await engine.metrics.record(t.accountId, t.region, "AWS/DynamoDB", metric, dims, units, "Count");
}

const readUnits = (bytes: number, consistent: boolean) => Math.max(1, Math.ceil(bytes / 4096)) * (consistent ? 1 : 0.5);
const writeUnits = (bytes: number) => Math.max(1, Math.ceil(bytes / 1024));

/** Checks the item's key attributes against the table and its indexes, as PutItem does. */
function checkKeyAttributes(t: Resource, item: Item) {
  const key = tableKey(t);
  for (const k of [key.partition, ...(key.sort ? [key.sort] : [])]) {
    const v = item[k.name];
    if (!v) throw validation(`One or more parameter values were invalid: Missing the key ${k.name} in the item`);
    if (typeOf(v) !== k.type) throw validation(`One or more parameter values were invalid: Type mismatch for key ${k.name} expected: ${k.type} actual: ${typeOf(v)}`);
    if (Object.values(v)[0] === "") throw validation(`One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: ${k.name}`);
  }
  for (const idx of indexesOf(t)) {
    for (const k of [idx.partition, ...(idx.sort ? [idx.sort] : [])]) {
      const v = item[k.name];
      if (v && typeOf(v) !== k.type) throw validation(`One or more parameter values were invalid: Type mismatch for Index Key ${k.name} Expected: ${k.type} Actual: ${typeOf(v)} IndexName: ${idx.name}`);
      if (v && Object.values(v)[0] === "") throw validation(`One or more parameter values are not valid. A value specified for a secondary index key is not supported. The AttributeValue for a key attribute cannot contain an empty string value. IndexName: ${idx.name}, IndexKey: ${k.name}`);
    }
  }
}

/** A Key parameter must hold exactly the key attributes. */
function checkKey(t: Resource, keyInput: unknown): Item {
  const key = tableKey(t);
  const k = checkItem(keyInput, "Key");
  const want = [key.partition, ...(key.sort ? [key.sort] : [])];
  if (Object.keys(k).length !== want.length || want.some((w) => !k[w.name])) throw validation("The provided key element does not match the schema");
  for (const w of want) if (typeOf(k[w.name]) !== w.type) throw validation("The provided key element does not match the schema");
  return k;
}

function conditionCheck(t: Resource, existing: Item | undefined, condition: string | undefined, ctx: ExprContext, returnOld: boolean) {
  if (!condition) return;
  const c = parseCondition(condition, "ConditionExpression", ctx);
  checkUnused(ctx);
  if (!evaluate(c, existing ?? {}, ctx)) {
    const e = new EngineError("ConditionalCheckFailedException", "The conditional request failed", 400);
    if (returnOld && existing) (e as EngineError & { item?: Item }).item = existing;
    throw e;
  }
}

async function failOnCondition<T>(engine: Engine, t: Resource, fn: () => T): Promise<T> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof EngineError && e.code === "ConditionalCheckFailedException") await bump(engine, t, { conditionalFailures: 1 });
    throw e;
  }
}

function checkLimits(items: Record<string, Item>) {
  if (Object.keys(items).length > MAX_ITEMS) throw new EngineError("LimitExceededException", `Nuvora keeps at most ${MAX_ITEMS} items per table. Delete some first.`, 400);
  if (Object.values(items).reduce((n, it) => n + itemSize(it), 0) > MAX_TABLE_BYTES) throw new EngineError("LimitExceededException", "Nuvora keeps at most 4 MB per table. Delete some items first.", 400);
}

export interface WriteInput extends ExpressionInput {
  condition?: string;
  returnValues?: string;
}

export async function putItem(engine: Engine, table: Resource, itemInput: unknown, input: WriteInput = {}): Promise<{ Attributes?: Item }> {
  const t = await load(engine, table);
  const item = checkItem(itemInput);
  checkKeyAttributes(t, item);
  const size = itemSize(item);
  if (size > MAX_ITEM_BYTES) throw validation("Item size has exceeded the maximum allowed size");
  const rv = input.returnValues ?? "NONE";
  if (!["NONE", "ALL_OLD"].includes(rv)) throw validation("ReturnValues can only be ALL_OLD or NONE");
  const ctx = context(input);
  const items = itemsOf(t);
  const k = keyString(tableKey(t), item);
  await failOnCondition(engine, t, () => conditionCheck(t, items[k], input.condition, ctx, false));
  if (!input.condition) checkUnused(ctx);
  await consume(engine, t, "write", writeUnits(size));
  const old = items[k];
  items[k] = item;
  checkLimits(items);
  await save(engine, t, items, { writes: 1 });
  return rv === "ALL_OLD" && old ? { Attributes: old } : {};
}

export interface ReadInput extends ExpressionInput {
  projection?: string;
  consistentRead?: boolean;
}

export async function getItem(engine: Engine, table: Resource, keyInput: unknown, input: ReadInput = {}): Promise<{ Item?: Item }> {
  const t = await load(engine, table);
  const key = checkKey(t, keyInput);
  const ctx = context(input);
  const paths = input.projection ? parseProjection(input.projection, ctx) : null;
  checkUnused(ctx);
  const item = itemsOf(t)[keyString(tableKey(t), key)];
  await consume(engine, t, "read", readUnits(item ? itemSize(item) : 1, input.consistentRead === true));
  await bump(engine, t, { reads: 1 });
  if (!item) return {};
  return { Item: paths ? project(item, paths) : item };
}

export async function deleteItem(engine: Engine, table: Resource, keyInput: unknown, input: WriteInput = {}): Promise<{ Attributes?: Item }> {
  const t = await load(engine, table);
  const key = checkKey(t, keyInput);
  const rv = input.returnValues ?? "NONE";
  if (!["NONE", "ALL_OLD"].includes(rv)) throw validation("ReturnValues can only be ALL_OLD or NONE");
  const ctx = context(input);
  const items = itemsOf(t);
  const k = keyString(tableKey(t), key);
  await failOnCondition(engine, t, () => conditionCheck(t, items[k], input.condition, ctx, false));
  if (!input.condition) checkUnused(ctx);
  const old = items[k];
  await consume(engine, t, "write", writeUnits(old ? itemSize(old) : 1));
  if (old) {
    delete items[k];
    await save(engine, t, items, { writes: 1 });
  }
  return rv === "ALL_OLD" && old ? { Attributes: old } : {};
}

export interface UpdateInput extends WriteInput {
  update: string;
}

export async function updateItem(engine: Engine, table: Resource, keyInput: unknown, input: UpdateInput): Promise<{ Attributes?: Item }> {
  const t = await load(engine, table);
  const key = checkKey(t, keyInput);
  const rv = input.returnValues ?? "NONE";
  if (!["NONE", "ALL_OLD", "UPDATED_OLD", "ALL_NEW", "UPDATED_NEW"].includes(rv)) throw validation("ReturnValues must be one of NONE, ALL_OLD, UPDATED_OLD, ALL_NEW, UPDATED_NEW");
  const ctx = context(input);
  const actions = parseUpdate(input.update, ctx);
  const tk = tableKey(t);
  for (const a of actions) {
    const top = String(a.path[0]);
    if (top === tk.partition.name || top === tk.sort?.name) {
      throw validation(`One or more parameter values were invalid: Cannot update attribute ${top}. This attribute is part of the key`);
    }
  }
  const items = itemsOf(t);
  const k = keyString(tk, key);
  const old = items[k];
  if (input.condition) {
    const c = parseCondition(input.condition, "ConditionExpression", ctx);
    checkUnused(ctx);
    if (!evaluate(c, old ?? {}, ctx)) {
      await bump(engine, t, { conditionalFailures: 1 });
      throw new EngineError("ConditionalCheckFailedException", "The conditional request failed", 400);
    }
  } else checkUnused(ctx);
  // UpdateItem creates the item if it doesn't exist (an "upsert").
  const updated = applyUpdate(old ?? key, actions, ctx);
  checkKeyAttributes(t, updated);
  const size = itemSize(updated);
  if (size > MAX_ITEM_BYTES) throw validation("Item size to update has exceeded the maximum allowed size");
  await consume(engine, t, "write", writeUnits(size));
  items[k] = updated;
  checkLimits(items);
  await save(engine, t, items, { writes: 1 });
  const touched = new Set(actions.map((a) => String(a.path[0])));
  const pick = (it: Item | undefined) => (it ? Object.fromEntries(Object.entries(it).filter(([n]) => touched.has(n))) : undefined);
  const out = rv === "ALL_NEW" ? updated : rv === "UPDATED_NEW" ? pick(updated) : rv === "ALL_OLD" ? old : rv === "UPDATED_OLD" ? pick(old) : undefined;
  return out && Object.keys(out).length ? { Attributes: out } : {};
}

// ---------- Query and Scan ----------

export interface QueryInput extends ReadInput {
  keyCondition: string;
  filter?: string;
  indexName?: string;
  scanIndexForward?: boolean;
  limit?: number;
  exclusiveStartKey?: Item;
  select?: string;
}

export interface PageResult {
  Items?: Item[];
  Count: number;
  ScannedCount: number;
  LastEvaluatedKey?: Item;
}

function keyOfItem(t: Resource, item: Item, idx?: KeyDef): Item {
  const key = tableKey(t);
  const names = [key.partition.name, key.sort?.name, idx?.partition.name, idx?.sort?.name].filter(Boolean) as string[];
  return Object.fromEntries(names.filter((n) => item[n]).map((n) => [n, item[n]]));
}

function page(t: Resource, candidates: Item[], input: { filter?: string; limit?: number; exclusiveStartKey?: Item; projection?: string; select?: string }, ctx: ExprContext, kind: "Query" | "Scan", idx?: KeyDef) {
  const filter = input.filter ? parseCondition(input.filter, "FilterExpression", ctx) : null;
  const paths = input.projection ? parseProjection(input.projection, ctx) : null;
  checkUnused(ctx);
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw validation(`1 validation error detected: Value '${input.limit}' at 'limit' failed to satisfy constraint: Member must have value greater than or equal to 1`);
  }
  let start = 0;
  if (input.exclusiveStartKey) {
    const want = JSON.stringify(keyOfItem(t, input.exclusiveStartKey, idx));
    const i = candidates.findIndex((it) => JSON.stringify(keyOfItem(t, it, idx)) === want);
    if (i === -1 && kind === "Query") throw validation("The provided starting key is invalid: The provided key element does not match the schema");
    start = i + 1;
  }
  const out: Item[] = [];
  let scanned = 0;
  let bytes = 0;
  let last: Item | undefined;
  for (let i = start; i < candidates.length; i++) {
    const it = candidates[i];
    scanned++;
    bytes += itemSize(it);
    // The limit and the 1 MB cap count items read, before the filter.
    if (!filter || evaluate(filter, it, ctx)) out.push(paths ? project(it, paths) : it);
    const stop = (input.limit !== undefined && scanned >= input.limit) || bytes >= PAGE_BYTES;
    if (stop && i < candidates.length - 1) {
      last = keyOfItem(t, it, idx);
      break;
    }
  }
  return { out, scanned, bytes, last };
}

function sortItems(items: Item[], sortName: string | undefined, forward: boolean) {
  if (!sortName) return items;
  return [...items].sort((a, b) => {
    const d = compare(a[sortName], b[sortName]) ?? 0;
    return forward ? d : -d;
  });
}

export async function query(engine: Engine, table: Resource, input: QueryInput): Promise<PageResult> {
  const t = await load(engine, table);
  const ctx = context(input);
  let key: KeyDef = tableKey(t);
  if (input.indexName) {
    const idx = indexesOf(t).find((i) => i.name === input.indexName);
    if (!idx) throw validation(`The table does not have the specified index: ${input.indexName}`);
    if (input.consistentRead) throw validation("Consistent reads are not supported on global secondary indexes");
    key = idx;
  }
  if (!input.keyCondition) throw validation("Either the KeyConditions or KeyConditionExpression parameter must be specified in the request.");
  const kc = parseKeyCondition(input.keyCondition, ctx, { partition: key.partition.name, sort: key.sort?.name });
  if (typeOf(kc.partition.value) !== key.partition.type) throw validation("One or more parameter values were invalid: Condition parameter type does not match schema type");
  if (kc.sort && kc.sort.values.some((v) => typeOf(v) !== key.sort!.type)) throw validation("One or more parameter values were invalid: Condition parameter type does not match schema type");
  if (kc.sort?.op === "begins_with" && key.sort?.type === "N") throw validation("Invalid KeyConditionExpression: Incorrect operand type for operator or function; operator or function: begins_with, operand type: N");
  const inPartition = Object.values(itemsOf(t)).filter((it) => {
    const pv = it[key.partition.name];
    return pv && JSON.stringify(pv) === JSON.stringify(kc.partition.value) && (!key.sort || it[key.sort.name]) && sortMatches(kc.sort, key.sort ? it[key.sort.name] : undefined);
  });
  const sorted = sortItems(inPartition, key.sort?.name, input.scanIndexForward !== false);
  const r = page(t, sorted, input, ctx, "Query", input.indexName ? key : undefined);
  await consume(engine, t, "read", readUnits(r.bytes, input.consistentRead === true));
  await bump(engine, t, { queries: 1, indexQueries: input.indexName ? 1 : 0 });
  await engine.metrics.record(t.accountId, t.region, "AWS/DynamoDB", "ReturnedItemCount", { TableName: t.name, Operation: "Query" }, r.out.length, "Count");
  return { ...(input.select === "COUNT" ? {} : { Items: r.out }), Count: r.out.length, ScannedCount: r.scanned, ...(r.last ? { LastEvaluatedKey: r.last } : {}) };
}

export interface ScanInput extends ReadInput {
  filter?: string;
  indexName?: string;
  limit?: number;
  exclusiveStartKey?: Item;
  select?: string;
}

export async function scan(engine: Engine, table: Resource, input: ScanInput = {}): Promise<PageResult> {
  const t = await load(engine, table);
  const ctx = context(input);
  let all = Object.values(itemsOf(t));
  let idx: KeyDef | undefined;
  if (input.indexName) {
    idx = indexesOf(t).find((i) => i.name === input.indexName);
    if (!idx) throw validation(`The table does not have the specified index: ${input.indexName}`);
    all = all.filter((it) => it[idx!.partition.name] && (!idx!.sort || it[idx!.sort.name]));
  }
  // A scan reads every item, in the table's own (hash) order.
  const key = tableKey(t);
  all.sort((a, b) => JSON.stringify(a[key.partition.name]).localeCompare(JSON.stringify(b[key.partition.name])) || (key.sort ? (compare(a[key.sort.name], b[key.sort.name]) ?? 0) : 0));
  const r = page(t, all, input, ctx, "Scan", idx);
  await consume(engine, t, "read", readUnits(r.bytes, input.consistentRead === true));
  await bump(engine, t, { scans: 1 });
  await engine.metrics.record(t.accountId, t.region, "AWS/DynamoDB", "ReturnedItemCount", { TableName: t.name, Operation: "Scan" }, r.out.length, "Count");
  return { ...(input.select === "COUNT" ? {} : { Items: r.out }), Count: r.out.length, ScannedCount: r.scanned, ...(r.last ? { LastEvaluatedKey: r.last } : {}) };
}
