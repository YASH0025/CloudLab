import { EngineError } from "../errors";

/**
 * DynamoDB's typed attribute values ({"S": "x"}, {"N": "42"}, {"M": {...}}…):
 * checking them, comparing them, sizing items, and converting to and from
 * plain JSON (what the console shows).
 */

export type AttributeValue =
  | { S: string }
  | { N: string }
  | { B: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { L: AttributeValue[] }
  | { M: Record<string, AttributeValue> }
  | { SS: string[] }
  | { NS: string[] }
  | { BS: string[] };

export type Item = Record<string, AttributeValue>;

export const validation = (message: string) => new EngineError("ValidationException", message, 400);

const TYPES = ["S", "N", "B", "BOOL", "NULL", "L", "M", "SS", "NS", "BS"];

export const typeOf = (v: AttributeValue): string => Object.keys(v)[0];

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Checks an attribute value's shape, as DynamoDB's request validation does. */
export function checkValue(v: unknown, where: string): AttributeValue {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw validation(`Supplied AttributeValue is empty, must contain exactly one of the supported datatypes`);
  const keys = Object.keys(v);
  if (keys.length !== 1 || !TYPES.includes(keys[0])) {
    if (keys.length > 1) throw validation(`Supplied AttributeValue has more than one datatypes set, must contain exactly one of the supported datatypes`);
    throw validation(`Supplied AttributeValue is empty, must contain exactly one of the supported datatypes`);
  }
  const t = keys[0];
  const val = (v as Record<string, unknown>)[t];
  switch (t) {
    case "S":
    case "B":
      if (typeof val !== "string") throw validation(`One or more parameter values were invalid: ${where}: ${t} must be a string`);
      break;
    case "N":
      if (typeof val !== "string" || !NUMBER.test(val.trim())) throw validation(`The parameter cannot be converted to a numeric value: ${String(val)}`);
      break;
    case "BOOL":
      if (typeof val !== "boolean") throw validation(`One or more parameter values were invalid: ${where}: BOOL must be true or false`);
      break;
    case "NULL":
      if (val !== true) throw validation(`One or more parameter values were invalid: Null attribute value types must have the value of true`);
      break;
    case "L":
      if (!Array.isArray(val)) throw validation(`One or more parameter values were invalid: ${where}: L must be a list`);
      val.forEach((x, i) => checkValue(x, `${where}[${i}]`));
      break;
    case "M":
      if (!val || typeof val !== "object" || Array.isArray(val)) throw validation(`One or more parameter values were invalid: ${where}: M must be a map`);
      for (const [k, x] of Object.entries(val)) checkValue(x, `${where}.${k}`);
      break;
    case "SS":
    case "NS":
    case "BS": {
      if (!Array.isArray(val)) throw validation(`One or more parameter values were invalid: ${where}: ${t} must be a list`);
      if (val.length === 0) throw validation("One or more parameter values were invalid: An string set  may not be empty".replace("string", t === "NS" ? "number" : t === "BS" ? "binary" : "string"));
      if (t === "NS") for (const n of val) if (typeof n !== "string" || !NUMBER.test(n)) throw validation(`The parameter cannot be converted to a numeric value: ${String(n)}`);
      if (new Set(val.map(String)).size !== val.length) throw validation(`One or more parameter values were invalid: Input collection [${val.join(", ")}] contains duplicates.`);
      break;
    }
  }
  return v as AttributeValue;
}

export function checkItem(item: unknown, where = "Item"): Item {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw validation(`1 validation error detected: Value null at '${where.toLowerCase()}' failed to satisfy constraint: Member must not be null`);
  for (const [k, v] of Object.entries(item)) {
    if (k.length === 0) throw validation("One or more parameter values were invalid: An AttributeValue may not contain an empty attribute name");
    checkValue(v, k);
  }
  return item as Item;
}

/** Comparison for sort keys and conditions: numbers numerically, strings by UTF-8 bytes. */
export function compare(a: AttributeValue, b: AttributeValue): number | null {
  const ta = typeOf(a);
  if (ta !== typeOf(b)) return null;
  if (ta === "N") return Number((a as { N: string }).N) - Number((b as { N: string }).N);
  if (ta === "S" || ta === "B") {
    const x = Buffer.from((a as { S: string }).S ?? (a as { B: string }).B);
    const y = Buffer.from((b as { S: string }).S ?? (b as { B: string }).B);
    return Buffer.compare(x, y);
  }
  return null;
}

export function equal(a: AttributeValue | undefined, b: AttributeValue | undefined): boolean {
  if (!a || !b) return false;
  const t = typeOf(a);
  if (t !== typeOf(b)) return false;
  if (t === "N") return Number((a as { N: string }).N) === Number((b as { N: string }).N);
  if (t === "SS" || t === "NS" || t === "BS") {
    const x = [...(Object.values(a)[0] as string[])].map(String).sort();
    const y = [...(Object.values(b)[0] as string[])].map(String).sort();
    return t === "NS" ? x.length === y.length && x.every((v, i) => Number(v) === Number(y[i])) : JSON.stringify(x) === JSON.stringify(y);
  }
  if (t === "L") {
    const x = (a as { L: AttributeValue[] }).L;
    const y = (b as { L: AttributeValue[] }).L;
    return x.length === y.length && x.every((v, i) => equal(v, y[i]));
  }
  if (t === "M") {
    const x = (a as { M: Record<string, AttributeValue> }).M;
    const y = (b as { M: Record<string, AttributeValue> }).M;
    const kx = Object.keys(x).sort();
    return JSON.stringify(kx) === JSON.stringify(Object.keys(y).sort()) && kx.every((k) => equal(x[k], y[k]));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Item size as DynamoDB counts it (attribute names + values), approximately. */
export function itemSize(item: Item): number {
  const size = (v: AttributeValue): number => {
    const t = typeOf(v);
    const val = Object.values(v)[0];
    if (t === "S" || t === "B") return Buffer.byteLength(String(val));
    if (t === "N") return Math.ceil(String(val).replace(/^[-+]/, "").length / 2) + 1;
    if (t === "BOOL" || t === "NULL") return 1;
    if (t === "L") return 3 + (val as AttributeValue[]).reduce((n, x) => n + 1 + size(x), 0);
    if (t === "M") return 3 + Object.entries(val as Record<string, AttributeValue>).reduce((n, [k, x]) => n + 1 + Buffer.byteLength(k) + size(x), 0);
    return (val as string[]).reduce((n, x) => n + Buffer.byteLength(x), 0);
  };
  return Object.entries(item).reduce((n, [k, v]) => n + Buffer.byteLength(k) + size(v), 0);
}

// ---------- plain JSON ⇄ DynamoDB JSON ----------

/** Plain JSON → DynamoDB JSON: strings S, numbers N, booleans BOOL, null NULL, arrays L, objects M. */
export function marshall(value: unknown): AttributeValue {
  if (value === null || value === undefined) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw validation(`The parameter cannot be converted to a numeric value: ${value}`);
    return { N: String(value) };
  }
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(marshall) };
  if (typeof value === "object") return { M: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, marshall(v)])) };
  throw validation(`Unsupported value: ${String(value)}`);
}

export const marshallItem = (obj: Record<string, unknown>): Item => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, marshall(v)]));

/** DynamoDB JSON → plain JSON. Sets become arrays; numbers become numbers when they fit. */
export function unmarshall(v: AttributeValue): unknown {
  const t = typeOf(v);
  const val = Object.values(v)[0];
  switch (t) {
    case "N": {
      const n = Number(val);
      return Number.isSafeInteger(n) || !Number.isInteger(n) ? n : String(val);
    }
    case "NULL":
      return null;
    case "L":
      return (val as AttributeValue[]).map(unmarshall);
    case "M":
      return Object.fromEntries(Object.entries(val as Record<string, AttributeValue>).map(([k, x]) => [k, unmarshall(x)]));
    case "NS":
      return (val as string[]).map(Number);
    default:
      return val;
  }
}

export const unmarshallItem = (item: Item): Record<string, unknown> => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, unmarshall(v)]));

/** Shown in messages, e.g. "{S: abc}". */
export const describeValue = (v: AttributeValue) => `${typeOf(v)}: ${JSON.stringify(Object.values(v)[0])}`;
