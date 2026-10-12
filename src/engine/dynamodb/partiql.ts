import type { TableHost } from "./host";
import { EngineError } from "../errors";
import { indexesOf, tableKey, type KeyDef } from "../services/dynamodb";
import type { Resource } from "../types";
import { deleteItem, putItem, query, scan, updateItem } from "./items";
import { checkValue, validation, type AttributeValue, type Item } from "./values";

/**
 * PartiQL for DynamoDB: SELECT, INSERT, UPDATE and DELETE written like SQL.
 * Statements are translated into the same operations as the API (Query when
 * the WHERE clause fixes the partition key, otherwise Scan; PutItem,
 * UpdateItem, DeleteItem), so they behave and fail the same way. The result
 * says which operation ran and how many items were read.
 */

export interface StatementResult {
  Items?: Item[];
  /** What it ran as, for the console: "Query", "Scan", "PutItem"… */
  ranAs: string;
  index?: string;
  scannedCount?: number;
  /** The equivalent expressions, to show how PartiQL maps onto the API. */
  translated?: { keyCondition?: string; filter?: string; update?: string; condition?: string };
}

const malformed = (msg: string) => validation(`Statement wasn't well formed, can't be processed: ${msg}`);

// ---------- tokens ----------

interface Tok {
  k: "ident" | "qident" | "str" | "num" | "punct" | "param" | "end";
  v: string;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= src.length) throw malformed(`Unterminated ${ch === "'" ? "string literal" : "quoted identifier"}`);
        if (src[j] === ch) {
          if (src[j + 1] === ch) {
            s += ch;
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      out.push({ k: ch === "'" ? "str" : "qident", v: s });
      i = j + 1;
      continue;
    }
    const rest = src.slice(i);
    const num = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(rest);
    if (num && !(ch === "-" && out.length && ["num", "ident", "qident", "str"].includes(out[out.length - 1].k))) {
      out.push({ k: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (id) {
      out.push({ k: "ident", v: id[0] });
      i += id[0].length;
      continue;
    }
    const p = /^(<<|>>|<=|>=|<>|!=|[=<>,()[\]{}.:+\-*?])/.exec(rest);
    if (!p) throw malformed(`Unexpected character: ${ch}`);
    out.push({ k: p[0] === "?" ? "param" : "punct", v: p[0] });
    i += p[0].length;
  }
  out.push({ k: "end", v: "<EOF>" });
  return out;
}

// ---------- parser: builds DynamoDB expressions with placeholders ----------

class P {
  i = 0;
  names: Record<string, string> = {};
  values: Record<string, AttributeValue> = {};
  private nameIds = new Map<string, string>();
  private paramIndex = 0;
  constructor(
    private t: Tok[],
    private params: AttributeValue[],
  ) {}

  peek(o = 0) {
    return this.t[this.i + o];
  }
  next() {
    return this.t[this.i++];
  }
  kw(word: string, o = 0) {
    const x = this.peek(o);
    return x.k === "ident" && x.v.toUpperCase() === word;
  }
  is(v: string) {
    return this.peek().k === "punct" && this.peek().v === v;
  }
  expectKw(word: string) {
    if (!this.kw(word)) throw malformed(`Unexpected token: ${this.peek().v}, expected ${word}`);
    this.next();
  }
  expect(v: string) {
    if (!this.is(v)) throw malformed(`Unexpected token: ${this.peek().v}, expected ${v}`);
    this.next();
  }

  /** "Table" or Table, optionally ."Index". */
  tableRef(): { table: string; index?: string } {
    const a = this.next();
    if (a.k !== "qident" && a.k !== "ident") throw malformed(`Unexpected token: ${a.v}, expected a table name`);
    if (this.is(".")) {
      this.next();
      const b = this.next();
      if (b.k !== "qident" && b.k !== "ident") throw malformed(`Unexpected token: ${b.v}, expected an index name`);
      return { table: a.v, index: b.v };
    }
    return { table: a.v };
  }

  nameRef(raw: string): string {
    let id = this.nameIds.get(raw);
    if (!id) {
      id = `#n${this.nameIds.size}`;
      this.nameIds.set(raw, id);
      this.names[id] = raw;
    }
    return id;
  }

  valueRef(v: AttributeValue): string {
    const id = `:v${Object.keys(this.values).length}`;
    this.values[id] = v;
    return id;
  }

  /** A path such as "address"."city" or items[0] → raw names and the placeholder text. */
  path(): { raw: string[]; text: string } {
    const first = this.next();
    if (first.k !== "qident" && first.k !== "ident") throw malformed(`Unexpected token: ${first.v}`);
    const raw = [first.v];
    let text = this.nameRef(first.v);
    for (;;) {
      if (this.is(".")) {
        this.next();
        const n = this.next();
        if (n.k !== "qident" && n.k !== "ident") throw malformed(`Unexpected token: ${n.v}`);
        raw.push(n.v);
        text += `.${this.nameRef(n.v)}`;
      } else if (this.is("[")) {
        this.next();
        const n = this.next();
        if (n.k !== "num") throw malformed(`Unexpected token: ${n.v}, expected a list index`);
        this.expect("]");
        text += `[${n.v}]`;
      } else return { raw, text };
    }
  }

  /** A literal: 'text', 12, true, false, null, [..], {..}, <<..>>, or ? */
  literal(): AttributeValue {
    const x = this.next();
    if (x.k === "str") return { S: x.v };
    if (x.k === "num") return { N: x.v };
    if (x.k === "param") {
      const v = this.params[this.paramIndex++];
      if (!v) throw validation("Number of parameters in request and statement don't match.");
      return checkValue(v, "Parameters");
    }
    if (x.k === "ident") {
      const u = x.v.toUpperCase();
      if (u === "TRUE" || u === "FALSE") return { BOOL: u === "TRUE" };
      if (u === "NULL") return { NULL: true };
    }
    if (x.k === "punct" && x.v === "[") {
      const items: AttributeValue[] = [];
      while (!this.is("]")) {
        items.push(this.literal());
        if (this.is(",")) this.next();
        else break;
      }
      this.expect("]");
      return { L: items };
    }
    if (x.k === "punct" && x.v === "{") {
      const m: Record<string, AttributeValue> = {};
      while (!this.is("}")) {
        const k = this.next();
        if (k.k !== "str") throw malformed(`Unexpected token: ${k.v}, map keys must be 'quoted'`);
        this.expect(":");
        m[k.v] = this.literal();
        if (this.is(",")) this.next();
        else break;
      }
      this.expect("}");
      return { M: m };
    }
    if (x.k === "punct" && x.v === "<<") {
      const vals: AttributeValue[] = [];
      while (!this.is(">>")) {
        vals.push(this.literal());
        if (this.is(",")) this.next();
        else break;
      }
      this.expect(">>");
      if (vals.length === 0) throw validation("One or more parameter values were invalid: An string set  may not be empty");
      if (vals.every((v) => "S" in v)) return { SS: vals.map((v) => (v as { S: string }).S) };
      if (vals.every((v) => "N" in v)) return { NS: vals.map((v) => (v as { N: string }).N) };
      throw validation("Sets must hold values of one type (all strings or all numbers)");
    }
    throw malformed(`Unexpected token: ${x.v}`);
  }

  isLiteralStart() {
    const x = this.peek();
    return x.k === "str" || x.k === "num" || x.k === "param" || (x.k === "punct" && ["[", "{", "<<"].includes(x.v)) || (x.k === "ident" && ["TRUE", "FALSE", "NULL"].includes(x.v.toUpperCase()));
  }

  operand(): { text: string; raw?: string[]; value?: AttributeValue } {
    if (this.isLiteralStart()) {
      const v = this.literal();
      return { text: this.valueRef(v), value: v };
    }
    const p = this.path();
    return { text: p.text, raw: p.raw };
  }

  // WHERE: returns a list of top-level AND conjuncts (each as text plus what it says about keys).
  condition(): Conj[] {
    const parts = [this.orExpr()];
    return parts.length === 1 && parts[0].and ? parts[0].and : parts;
  }

  orExpr(): Conj {
    let left = this.andExpr();
    while (this.kw("OR")) {
      this.next();
      const right = this.andExpr();
      left = { text: `(${left.text}) OR (${right.text})` };
    }
    return left;
  }

  andExpr(): Conj {
    const parts = [this.notExpr()];
    while (this.kw("AND")) {
      this.next();
      parts.push(this.notExpr());
    }
    if (parts.length === 1) return parts[0];
    const flat = parts.flatMap((p) => p.and ?? [p]);
    return { text: flat.map((p) => `(${p.text})`).join(" AND "), and: flat };
  }

  notExpr(): Conj {
    if (this.kw("NOT")) {
      this.next();
      const c = this.notExpr();
      return { text: `NOT (${c.text})` };
    }
    return this.primary();
  }

  primary(): Conj {
    if (this.is("(")) {
      this.next();
      const c = this.orExpr();
      this.expect(")");
      return c;
    }
    const fn = this.peek();
    if (fn.k === "ident" && ["BEGINS_WITH", "CONTAINS", "ATTRIBUTE_TYPE", "SIZE"].includes(fn.v.toUpperCase()) && this.peek(1).v === "(") {
      const name = fn.v.toLowerCase();
      this.next();
      this.expect("(");
      const a = this.path();
      if (name === "size") {
        this.expect(")");
        const op = this.next();
        if (!["=", "<>", "!=", "<", "<=", ">", ">="].includes(op.v)) throw malformed(`Unexpected token: ${op.v}`);
        const b = this.operand();
        return { text: `size(${a.text}) ${op.v === "!=" ? "<>" : op.v} ${b.text}` };
      }
      this.expect(",");
      const b = this.operand();
      this.expect(")");
      return { text: `${name}(${a.text}, ${b.text})`, key: name === "begins_with" ? { attr: a.raw.join("."), op: "begins_with" } : undefined };
    }
    const left = this.operand();
    if (this.kw("IS")) {
      this.next();
      const not = this.kw("NOT");
      if (not) this.next();
      if (this.kw("MISSING")) {
        this.next();
        return { text: `${not ? "attribute_exists" : "attribute_not_exists"}(${left.text})` };
      }
      if (this.kw("NULL")) {
        this.next();
        return { text: `${not ? "NOT " : ""}attribute_type(${left.text}, ${this.valueRef({ S: "NULL" })})` };
      }
      throw malformed(`Unexpected token: ${this.peek().v}, expected MISSING or NULL`);
    }
    if (this.kw("BETWEEN")) {
      this.next();
      const lo = this.operand();
      this.expectKw("AND");
      const hi = this.operand();
      return { text: `${left.text} BETWEEN ${lo.text} AND ${hi.text}`, key: left.raw ? { attr: left.raw.join("."), op: "BETWEEN" } : undefined };
    }
    if (this.kw("IN")) {
      this.next();
      const close = this.is("[") ? "]" : ")";
      this.next();
      const list = [this.operand().text];
      while (this.is(",")) {
        this.next();
        list.push(this.operand().text);
      }
      this.expect(close);
      return { text: `${left.text} IN (${list.join(", ")})` };
    }
    const op = this.next();
    if (!["=", "<>", "!=", "<", "<=", ">", ">="].includes(op.v)) throw malformed(`Unexpected token: ${op.v}`);
    const right = this.operand();
    const sym = op.v === "!=" ? "<>" : op.v;
    // "key op literal" (or the other way round) may become part of a key condition.
    const keyAttr = left.raw && right.value ? left.raw.join(".") : right.raw && left.value ? right.raw.join(".") : undefined;
    return { text: `${left.text} ${sym} ${right.text}`, key: keyAttr ? { attr: keyAttr, op: sym, value: left.value ?? right.value } : undefined };
  }

  end() {
    if (this.peek().k !== "end") throw malformed(`Unexpected token: ${this.peek().v}`);
    if (this.paramIndex !== this.params.length) throw validation("Number of parameters in request and statement don't match.");
  }
}

interface Conj {
  text: string;
  /** Top-level AND parts, when this is an AND. */
  and?: Conj[];
  /** What this conjunct says about one attribute, if it could serve as a key condition. */
  key?: { attr: string; op: string; value?: AttributeValue };
}

function splitKey(conjs: Conj[], key: KeyDef) {
  const pk = conjs.find((c) => c.key?.attr === key.partition.name && c.key.op === "=");
  if (!pk) return null;
  const sk = key.sort ? conjs.find((c) => c !== pk && c.key?.attr === key.sort!.name && ["=", "<", "<=", ">", ">=", "BETWEEN", "begins_with"].includes(c.key.op)) : undefined;
  const rest = conjs.filter((c) => c !== pk && c !== sk);
  return { keyCondition: [pk, sk].filter(Boolean).map((c) => c!.text).join(" AND "), filter: rest.map((c) => `(${c.text})`).join(" AND ") || undefined };
}

/** Keeps only the placeholders an expression set actually uses (DynamoDB rejects unused ones). */
function used(p: P, ...texts: (string | undefined)[]) {
  const all = texts.filter(Boolean).join(" ");
  const names = Object.fromEntries(Object.entries(p.names).filter(([k]) => new RegExp(`${k}(?![0-9])`).test(all)));
  const values = Object.fromEntries(Object.entries(p.values).filter(([k]) => new RegExp(`${k}(?![0-9])`).test(all)));
  return { names: Object.keys(names).length ? names : undefined, values: Object.keys(values).length ? values : undefined };
}

async function findTable(engine: TableHost, accountId: string, region: string, name: string): Promise<Resource> {
  const t = (await engine.list(accountId, { service: "dynamodb", type: "table", region })).find((x) => x.name === name);
  if (!t) throw new EngineError("ResourceNotFoundException", "Requested resource not found", 400);
  return t;
}

function fullKeyFrom(conjs: Conj[], key: KeyDef): { key: Item; rest: Conj[] } {
  const want = [key.partition, ...(key.sort ? [key.sort] : [])];
  const k: Item = {};
  const rest = [...conjs];
  for (const w of want) {
    const c = rest.find((x) => x.key?.attr === w.name && x.key.op === "=" && x.key.value);
    if (!c) throw validation("Where clause does not contain a mandatory equality on all key attributes");
    k[w.name] = c.key!.value!;
    rest.splice(rest.indexOf(c), 1);
  }
  return { key: k, rest };
}

/** Shows an expression with its placeholders filled in, e.g. status = 'placed'. */
function readable(p: P, r: StatementResult): StatementResult {
  if (!r.translated) return r;
  const lit = (v: AttributeValue) => ("S" in v ? `'${v.S}'` : "N" in v ? v.N : JSON.stringify(Object.values(v)[0]));
  const fill = (text?: string) =>
    text
      ?.replace(/#n\d+/g, (m) => p.names[m] ?? m)
      .replace(/:v\d+/g, (m) => (p.values[m] ? lit(p.values[m]) : m))
      .replace(/^\((.*)\)$/, "$1");
  return { ...r, translated: Object.fromEntries(Object.entries(r.translated).map(([k, v]) => [k, fill(v)])) };
}

/** ExecuteStatement. */
export async function executeStatement(engine: TableHost, accountId: string, region: string, statement: string, params: AttributeValue[] = []): Promise<StatementResult> {
  const p = new P(tokenize(statement.trim() ? statement : "x"), params);
  return readable(p, await run(engine, accountId, region, statement, p));
}

async function run(engine: TableHost, accountId: string, region: string, statement: string, p: P): Promise<StatementResult> {
  if (!statement.trim()) throw validation("1 validation error detected: Value '' at 'statement' failed to satisfy constraint: Member must have length greater than or equal to 1");

  if (p.kw("SELECT")) {
    p.next();
    let projection: string | undefined;
    if (p.is("*")) p.next();
    else {
      const paths = [p.path().text];
      while (p.is(",")) {
        p.next();
        paths.push(p.path().text);
      }
      projection = paths.join(", ");
    }
    p.expectKw("FROM");
    const ref = p.tableRef();
    let conjs: Conj[] = [];
    if (p.kw("WHERE")) {
      p.next();
      conjs = p.condition();
    }
    let desc = false;
    let orderBy: string | undefined;
    if (p.kw("ORDER")) {
      p.next();
      p.expectKw("BY");
      const o = p.path();
      orderBy = o.raw.join(".");
      if (p.kw("ASC")) p.next();
      else if (p.kw("DESC")) {
        p.next();
        desc = true;
      }
    }
    p.end();
    const t = await findTable(engine, accountId, region, ref.table);
    let key: KeyDef = tableKey(t);
    if (ref.index) {
      const idx = indexesOf(t).find((x) => x.name === ref.index);
      if (!idx) throw validation(`The table does not have the specified index: ${ref.index}`);
      key = idx;
    }
    const split = splitKey(conjs, key);
    if (orderBy) {
      if (!split) throw validation("Must have WHERE clause in the statement when using ORDER BY clause.");
      if (orderBy !== key.sort?.name && orderBy !== key.partition.name) throw validation("Variable reference " + orderBy + " in ORDER BY clause must be part of the primary key");
    }
    if (split) {
      const all = used(p, split.keyCondition, split.filter, projection);
      const r = await query(engine, t, { keyCondition: split.keyCondition, filter: split.filter, projection, ...all, indexName: ref.index, scanIndexForward: !desc });
      return { Items: r.Items, ranAs: "Query", index: ref.index, scannedCount: r.ScannedCount, translated: { keyCondition: split.keyCondition, filter: split.filter } };
    }
    const filter = conjs.length ? conjs.map((c) => `(${c.text})`).join(" AND ") : undefined;
    const all = used(p, filter, projection);
    const items: Item[] = [];
    let scanned = 0;
    let start: Item | undefined;
    for (let i = 0; i < 50; i++) {
      const r = await scan(engine, t, { filter, projection, ...all, indexName: ref.index, exclusiveStartKey: start });
      items.push(...(r.Items ?? []));
      scanned += r.ScannedCount;
      if (!r.LastEvaluatedKey) break;
      start = r.LastEvaluatedKey;
    }
    return { Items: items, ranAs: "Scan", index: ref.index, scannedCount: scanned, translated: { filter } };
  }

  if (p.kw("INSERT")) {
    p.next();
    p.expectKw("INTO");
    const ref = p.tableRef();
    if (ref.index) throw malformed("INSERT can't target an index");
    p.expectKw("VALUE");
    const v = p.literal();
    p.end();
    if (!("M" in v)) throw validation("Unexpected value type in VALUE clause: it must be a map, like {'id': '1'}");
    const t = await findTable(engine, accountId, region, ref.table);
    const k = tableKey(t);
    try {
      await putItem(engine, t, v.M, { condition: "attribute_not_exists(#pk)", names: { "#pk": k.partition.name } });
    } catch (e) {
      if (e instanceof EngineError && e.code === "ConditionalCheckFailedException") throw new EngineError("DuplicateItemException", "Duplicate primary key exists in table", 400);
      throw e;
    }
    return { ranAs: "PutItem", translated: { condition: `attribute_not_exists(${k.partition.name})` } };
  }

  if (p.kw("UPDATE")) {
    p.next();
    const ref = p.tableRef();
    const sets: string[] = [];
    const removes: string[] = [];
    while (p.kw("SET") || p.kw("REMOVE")) {
      const which = p.next().v.toUpperCase();
      do {
        if (p.is(",")) p.next();
        const target = p.path();
        if (which === "REMOVE") removes.push(target.text);
        else {
          p.expect("=");
          const a = p.operand();
          if (p.is("+") || p.is("-")) {
            const op = p.next().v;
            const b = p.operand();
            sets.push(`${target.text} = ${a.text} ${op} ${b.text}`);
          } else sets.push(`${target.text} = ${a.text}`);
        }
      } while (p.is(","));
    }
    if (!sets.length && !removes.length) throw malformed(`Unexpected token: ${p.peek().v}, expected SET or REMOVE`);
    p.expectKw("WHERE");
    const conjs = p.condition();
    p.end();
    const t = await findTable(engine, accountId, region, ref.table);
    const { key, rest } = fullKeyFrom(conjs, tableKey(t));
    // PartiQL's UPDATE only changes an item that exists.
    const pkName = Object.entries(p.names).find(([, v]) => v === tableKey(t).partition.name)?.[0] ?? p.nameRef(tableKey(t).partition.name);
    const condition = [`attribute_exists(${pkName})`, ...rest.map((c) => `(${c.text})`)].join(" AND ");
    const update = [sets.length ? `SET ${sets.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""].filter(Boolean).join(" ");
    const all = used(p, update, condition);
    await updateItem(engine, t, key, { update, condition, ...all });
    return { ranAs: "UpdateItem", translated: { update, condition } };
  }

  if (p.kw("DELETE")) {
    p.next();
    p.expectKw("FROM");
    const ref = p.tableRef();
    p.expectKw("WHERE");
    const conjs = p.condition();
    p.end();
    const t = await findTable(engine, accountId, region, ref.table);
    const { key, rest } = fullKeyFrom(conjs, tableKey(t));
    const condition = rest.length ? rest.map((c) => `(${c.text})`).join(" AND ") : undefined;
    const all = used(p, condition);
    await deleteItem(engine, t, key, { condition, ...all });
    return { ranAs: "DeleteItem", translated: condition ? { condition } : undefined };
  }

  throw malformed(`Unexpected keyword: ${p.peek().v}. Statements start with SELECT, INSERT, UPDATE or DELETE.`);
}
