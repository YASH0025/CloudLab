import { compare, equal, typeOf, validation, type AttributeValue, type Item } from "./values";

/**
 * DynamoDB expressions: condition and filter expressions, key conditions,
 * update expressions and projections. Placeholders (#name, :value) are
 * resolved from ExpressionAttributeNames / ExpressionAttributeValues, and
 * reserved words used as plain names are rejected, as DynamoDB does.
 */

export type ExprKind = "ConditionExpression" | "FilterExpression" | "KeyConditionExpression" | "UpdateExpression" | "ProjectionExpression";

export interface ExprContext {
  names?: Record<string, string>;
  values?: Record<string, AttributeValue>;
  /** Placeholders the expressions used, to report unused ones. */
  usedNames: Set<string>;
  usedValues: Set<string>;
}

/** Words DynamoDB reserves that people most often use as attribute names. */
const RESERVED = new Set(
  (
    "ABORT ABSOLUTE ACTION ADD AFTER AGENT AGGREGATE ALL ALLOCATE ALTER ANALYZE AND ANY ARCHIVE ARE ARRAY AS ASC ASCII ASENSITIVE ASSERTION ASYMMETRIC AT ATOMIC ATTACH ATTRIBUTE AUTH AUTHORIZATION AUTHORIZE AUTO AVG BACK BACKUP BASE BATCH BEFORE BEGIN BETWEEN BIGINT BINARY BIT BLOB BLOCK BOOLEAN BOTH BREADTH BUCKET BULK BY BYTE CALL CALLED CALLING CAPACITY CASCADE CASCADED CASE CAST CATALOG CHAR CHARACTER CHECK CLASS CLOB CLOSE CLUSTER CLUSTERED CLUSTERING CLUSTERS COALESCE COLLATE COLLATION COLLECTION COLUMN COLUMNS COMBINE COMMENT COMMIT COMPACT COMPILE COMPRESS CONDITION CONFLICT CONNECT CONNECTION CONSISTENCY CONSISTENT CONSTRAINT CONSTRAINTS CONSTRUCTOR CONSUMED CONTINUE CONVERT COPY CORRESPONDING COUNT COUNTER CREATE CROSS CUBE CURRENT CURSOR CYCLE DATA DATABASE DATE DATETIME DAY DEALLOCATE DEC DECIMAL DECLARE DEFAULT DEFERRABLE DEFERRED DEFINE DEFINED DEFINITION DELETE DELIMITED DEPTH DEREF DESC DESCRIBE DESCRIPTOR DETACH DETERMINISTIC DIAGNOSTICS DIRECTORIES DISABLE DISCONNECT DISTINCT DISTRIBUTE DO DOMAIN DOUBLE DROP DUMP DURATION DYNAMIC EACH ELEMENT ELSE ELSEIF EMPTY ENABLE END EQUAL EQUALS ERROR ESCAPE ESCAPED EVAL EVALUATE EXCEEDED EXCEPT EXCEPTION EXCEPTIONS EXCLUSIVE EXEC EXECUTE EXISTS EXIT EXPLAIN EXPLODE EXPORT EXPRESSION EXTENDED EXTERNAL EXTRACT FAIL FALSE FAMILY FETCH FIELDS FILE FILTER FILTERING FINAL FINISH FIRST FIXED FLATTERN FLOAT FOR FORCE FOREIGN FORMAT FORWARD FOUND FREE FROM FULL FUNCTION FUNCTIONS GENERAL GENERATE GET GLOB GLOBAL GO GOTO GRANT GREATER GROUP GROUPING HANDLER HASH HAVE HAVING HEAP HIDDEN HOLD HOUR IDENTIFIED IDENTITY IF IGNORE IMMEDIATE IMPORT IN INCLUDING INCLUSIVE INCREMENT INCREMENTAL INDEX INDEXED INDEXES INDICATOR INFINITE INITIALLY INLINE INNER INNTER INOUT INPUT INSENSITIVE INSERT INSTEAD INT INTEGER INTERSECT INTERVAL INTO INVALIDATE IS ISOLATION ITEM ITEMS ITERATE JOIN KEY KEYS LAG LANGUAGE LARGE LAST LATERAL LEAD LEADING LEAVE LEFT LENGTH LESS LEVEL LIKE LIMIT LIMITED LINES LIST LOAD LOCAL LOCALTIME LOCALTIMESTAMP LOCATION LOCATOR LOCK LOCKS LOG LOGED LONG LOOP LOWER MAP MATCH MATERIALIZED MAX MAXLEN MEMBER MERGE METHOD METRICS MIN MINUS MINUTE MISSING MOD MODE MODIFIES MODIFY MODULE MONTH MULTI MULTISET NAME NAMES NATIONAL NATURAL NCHAR NCLOB NEW NEXT NO NONE NOT NULL NULLIF NUMBER NUMERIC OBJECT OF OFFLINE OFFSET OLD ON ONLINE ONLY OPAQUE OPEN OPERATOR OPTION OR ORDER ORDINALITY OTHER OTHERS OUT OUTER OUTPUT OVER OVERLAPS OVERRIDE OWNER PAD PARALLEL PARAMETER PARAMETERS PARTIAL PARTITION PARTITIONED PARTITIONS PATH PERCENT PERCENTILE PERMISSION PERMISSIONS PIPE PIPELINED PLAN POOL POSITION PRECISION PREPARE PRESERVE PRIMARY PRIOR PRIVATE PRIVILEGES PROCEDURE PROCESSED PROJECT PROJECTION PROPERTY PROVISIONING PUBLIC PUT QUERY QUIT QUORUM RAISE RANDOM RANGE RANK RAW READ READS REAL REBUILD RECORD RECURSIVE REDUCE REF REFERENCE REFERENCES REFERENCING REGEXP REGION REINDEX RELATIVE RELEASE REMAINDER RENAME REPEAT REPLACE REQUEST RESET RESIGNAL RESOURCE RESPONSE RESTORE RESTRICT RESULT RETURN RETURNING RETURNS REVERSE REVOKE RIGHT ROLE ROLES ROLLBACK ROLLUP ROUTINE ROW ROWS RULE RULES SAMPLE SATISFIES SAVE SAVEPOINT SCAN SCHEMA SCOPE SCROLL SEARCH SECOND SECTION SEGMENT SEGMENTS SELECT SELF SEMI SENSITIVE SEPARATE SEQUENCE SERIALIZABLE SESSION SET SETS SHARD SHARE SHARED SHORT SHOW SIGNAL SIMILAR SIZE SKEWED SMALLINT SNAPSHOT SOME SOURCE SPACE SPACES SPARSE SPECIFIC SPECIFICTYPE SPLIT SQL SQLCODE SQLERROR SQLEXCEPTION SQLSTATE SQLWARNING START STATE STATIC STATUS STORAGE STORE STORED STREAM STRING STRUCT STYLE SUB SUBMULTISET SUBPARTITION SUBSTRING SUBTYPE SUM SUPER SYMMETRIC SYNONYM SYSTEM TABLE TABLESAMPLE TEMP TEMPORARY TERMINATED TEXT THAN THEN THROUGHPUT TIME TIMESTAMP TIMEZONE TINYINT TO TOKEN TOTAL TOUCH TRAILING TRANSACTION TRANSFORM TRANSLATE TRANSLATION TREAT TRIGGER TRIM TRUE TRUNCATE TTL TUPLE TYPE UNDER UNDO UNION UNIQUE UNIT UNKNOWN UNLOGGED UNNEST UNPROCESSED UNSIGNED UNTIL UPDATE UPPER URL USAGE USE USER USERS USING UUID VACUUM VALUE VALUED VALUES VARCHAR VARIABLE VARIANCE VARINT VARYING VIEW VIEWS VIRTUAL VOID WAIT WHEN WHENEVER WHERE WHILE WINDOW WITH WITHIN WITHOUT WORK WRAPPED WRITE YEAR ZONE"
  ).split(" "),
);

// ---------- tokens ----------

interface Token {
  kind: "name" | "hashName" | "value" | "number" | "op" | "punct" | "end";
  text: string;
  pos: number;
}

function tokenize(src: string, kind: ExprKind): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const rest = src.slice(i);
    const m =
      /^#[A-Za-z0-9_]+/.exec(rest) ??
      /^:[A-Za-z0-9_]+/.exec(rest) ??
      /^[A-Za-z_][A-Za-z0-9_-]*/.exec(rest) ??
      /^\d+/.exec(rest) ??
      /^(<=|>=|<>|=|<|>|\+|-)/.exec(rest) ??
      /^[(),.[\]]/.exec(rest);
    if (!m) throw validation(`Invalid ${kind}: Syntax error; token: "${ch}", near: "${src.slice(Math.max(0, i - 5), i + 5)}"`);
    const t = m[0];
    const k: Token["kind"] = t.startsWith("#") ? "hashName" : t.startsWith(":") ? "value" : /^\d/.test(t) ? "number" : /^[A-Za-z_]/.test(t) ? "name" : /^[(),.[\]]$/.test(t) ? "punct" : "op";
    out.push({ kind: k, text: t, pos: i });
    i += t.length;
  }
  out.push({ kind: "end", text: "<EOF>", pos: src.length });
  return out;
}

// ---------- AST ----------

export type PathPart = string | number;
export type Operand = { type: "path"; path: PathPart[] } | { type: "value"; name: string } | { type: "size"; path: PathPart[] };
export type Cond =
  | { type: "and" | "or"; left: Cond; right: Cond }
  | { type: "not"; cond: Cond }
  | { type: "cmp"; op: string; left: Operand; right: Operand }
  | { type: "between"; operand: Operand; low: Operand; high: Operand }
  | { type: "in"; operand: Operand; list: Operand[] }
  | { type: "fn"; name: string; args: Operand[] };

class Parser {
  i = 0;
  constructor(
    private tokens: Token[],
    private src: string,
    private kind: ExprKind,
    private ctx: ExprContext,
  ) {}

  peek() {
    return this.tokens[this.i];
  }
  next() {
    return this.tokens[this.i++];
  }
  /** The text of the token after the current one. */
  ahead() {
    return this.tokens[this.i + 1]?.text;
  }
  isKw(word: string, t = this.peek()) {
    return t.kind === "name" && t.text.toUpperCase() === word;
  }
  syntax(t = this.peek()): never {
    const near = this.src.slice(Math.max(0, t.pos - 6), t.pos + t.text.length + 6).trim();
    throw validation(`Invalid ${this.kind}: Syntax error; token: "${t.text}", near: "${near}"`);
  }
  expect(text: string) {
    const t = this.next();
    if (t.text !== text) this.syntax(t);
  }
  atEnd() {
    return this.peek().kind === "end";
  }

  /** a.b[0].#c */
  path(): PathPart[] {
    const parts: PathPart[] = [this.nameSegment()];
    for (;;) {
      if (this.peek().text === ".") {
        this.next();
        parts.push(this.nameSegment());
      } else if (this.peek().text === "[") {
        this.next();
        const n = this.next();
        if (n.kind !== "number") this.syntax(n);
        this.expect("]");
        parts.push(Number(n.text));
      } else return parts;
    }
  }

  nameSegment(): string {
    const t = this.next();
    if (t.kind === "hashName") {
      this.ctx.usedNames.add(t.text);
      const real = this.ctx.names?.[t.text];
      if (real === undefined) throw validation(`Invalid ${this.kind}: An expression attribute name used in the document path is not defined; attribute name: ${t.text}`);
      return real;
    }
    if (t.kind === "name") {
      if (RESERVED.has(t.text.toUpperCase())) throw validation(`Invalid ${this.kind}: Attribute name is a reserved keyword; reserved keyword: ${t.text}`);
      return t.text;
    }
    return this.syntax(t);
  }

  operand(): Operand {
    const t = this.peek();
    if (t.kind === "value") {
      this.next();
      this.ctx.usedValues.add(t.text);
      if (!this.ctx.values || !(t.text in this.ctx.values)) throw validation(`Invalid ${this.kind}: An expression attribute value used in expression is not defined; attribute value: ${t.text}`);
      return { type: "value", name: t.text };
    }
    if (this.isKw("SIZE") && this.tokens[this.i + 1]?.text === "(") {
      this.next();
      this.expect("(");
      const p = this.path();
      this.expect(")");
      return { type: "size", path: p };
    }
    if (t.kind === "name" || t.kind === "hashName") return { type: "path", path: this.path() };
    return this.syntax(t);
  }

  condition(): Cond {
    let left = this.andCond();
    while (this.isKw("OR")) {
      this.next();
      left = { type: "or", left, right: this.andCond() };
    }
    return left;
  }
  andCond(): Cond {
    let left = this.notCond();
    while (this.isKw("AND")) {
      this.next();
      left = { type: "and", left, right: this.notCond() };
    }
    return left;
  }
  notCond(): Cond {
    if (this.isKw("NOT")) {
      this.next();
      return { type: "not", cond: this.notCond() };
    }
    return this.primary();
  }
  primary(): Cond {
    const t = this.peek();
    if (t.text === "(") {
      this.next();
      const c = this.condition();
      this.expect(")");
      return c;
    }
    const fn = t.kind === "name" ? t.text : "";
    if (["attribute_exists", "attribute_not_exists", "attribute_type", "begins_with", "contains"].includes(fn) && this.tokens[this.i + 1]?.text === "(") {
      this.next();
      this.expect("(");
      const args: Operand[] = [this.operand()];
      while (this.peek().text === ",") {
        this.next();
        args.push(this.operand());
      }
      this.expect(")");
      const want = fn.startsWith("attribute_") && fn !== "attribute_type" ? 1 : 2;
      if (args.length !== want) throw validation(`Invalid ${this.kind}: Incorrect number of operands for operator or function; operator or function: ${fn}, number of operands: ${args.length}`);
      if (args[0].type !== "path") throw validation(`Invalid ${this.kind}: Operator or function requires a document path; operator or function: ${fn}`);
      return { type: "fn", name: fn, args };
    }
    const left = this.operand();
    const op = this.peek();
    if (op.kind === "op" && ["=", "<>", "<", "<=", ">", ">="].includes(op.text)) {
      this.next();
      return { type: "cmp", op: op.text, left, right: this.operand() };
    }
    if (this.isKw("BETWEEN")) {
      this.next();
      const low = this.operand();
      if (!this.isKw("AND")) this.syntax();
      this.next();
      return { type: "between", operand: left, low, high: this.operand() };
    }
    if (this.isKw("IN")) {
      this.next();
      this.expect("(");
      const list = [this.operand()];
      while (this.peek().text === ",") {
        this.next();
        list.push(this.operand());
      }
      this.expect(")");
      return { type: "in", operand: left, list };
    }
    return this.syntax(op);
  }
}

export function parseCondition(src: string, kind: ExprKind, ctx: ExprContext): Cond {
  if (!src.trim()) throw validation(`Invalid ${kind}: The expression can not be empty;`);
  const p = new Parser(tokenize(src, kind), src, kind, ctx);
  const c = p.condition();
  if (!p.atEnd()) p.syntax();
  return c;
}

// ---------- evaluation ----------

export function getPath(item: Item, path: PathPart[]): AttributeValue | undefined {
  let cur: AttributeValue | undefined = item[path[0] as string];
  for (const part of path.slice(1)) {
    if (!cur) return undefined;
    if (typeof part === "number") cur = "L" in cur ? cur.L[part] : undefined;
    else cur = "M" in cur ? cur.M[part] : undefined;
  }
  return cur;
}

function operandValue(item: Item, o: Operand, ctx: ExprContext): AttributeValue | undefined {
  if (o.type === "value") return ctx.values![o.name];
  if (o.type === "path") return getPath(item, o.path);
  const v = getPath(item, o.path);
  if (!v) return undefined;
  const t = typeOf(v);
  const val = Object.values(v)[0];
  const n = t === "S" || t === "B" ? Buffer.byteLength(String(val)) : t === "M" ? Object.keys(val as object).length : Array.isArray(val) ? val.length : undefined;
  return n === undefined ? undefined : { N: String(n) };
}

export function evaluate(c: Cond, item: Item, ctx: ExprContext): boolean {
  switch (c.type) {
    case "and":
      return evaluate(c.left, item, ctx) && evaluate(c.right, item, ctx);
    case "or":
      return evaluate(c.left, item, ctx) || evaluate(c.right, item, ctx);
    case "not":
      return !evaluate(c.cond, item, ctx);
    case "cmp": {
      const a = operandValue(item, c.left, ctx);
      const b = operandValue(item, c.right, ctx);
      if (c.op === "=") return equal(a, b);
      if (c.op === "<>") return !!a && !!b && !equal(a, b);
      if (!a || !b) return false;
      const d = compare(a, b);
      if (d === null) return false;
      return { "<": d < 0, "<=": d <= 0, ">": d > 0, ">=": d >= 0 }[c.op] ?? false;
    }
    case "between": {
      const v = operandValue(item, c.operand, ctx);
      const lo = operandValue(item, c.low, ctx);
      const hi = operandValue(item, c.high, ctx);
      if (!v || !lo || !hi) return false;
      const a = compare(v, lo);
      const b = compare(v, hi);
      return a !== null && b !== null && a >= 0 && b <= 0;
    }
    case "in": {
      const v = operandValue(item, c.operand, ctx);
      return c.list.some((o) => equal(v, operandValue(item, o, ctx)));
    }
    case "fn": {
      const v = operandValue(item, c.args[0], ctx);
      if (c.name === "attribute_exists") return v !== undefined;
      if (c.name === "attribute_not_exists") return v === undefined;
      const arg = operandValue(item, c.args[1], ctx);
      if (c.name === "attribute_type") return !!v && !!arg && "S" in arg && typeOf(v) === arg.S;
      if (!v || !arg) return false;
      if (c.name === "begins_with") return ("S" in v && "S" in arg && v.S.startsWith(arg.S)) || ("B" in v && "B" in arg && v.B.startsWith(arg.B));
      if (c.name === "contains") {
        if ("S" in v && "S" in arg) return v.S.includes(arg.S);
        if ("SS" in v && "S" in arg) return v.SS.includes(arg.S);
        if ("NS" in v && "N" in arg) return v.NS.some((n) => Number(n) === Number(arg.N));
        if ("L" in v) return v.L.some((x) => equal(x, arg));
        return false;
      }
      return false;
    }
  }
}

// ---------- key conditions ----------

export interface KeyCondition {
  partition: { name: string; value: AttributeValue };
  sort?: { name: string; op: "=" | "<" | "<=" | ">" | ">=" | "BETWEEN" | "begins_with"; values: AttributeValue[] };
}

/** Breaks a KeyConditionExpression into "pk = :v" and an optional sort key condition, with Query's errors. */
export function parseKeyCondition(src: string, ctx: ExprContext, key: { partition: string; sort?: string }): KeyCondition {
  const kind: ExprKind = "KeyConditionExpression";
  const c = parseCondition(src, kind, ctx);
  const parts: Cond[] = [];
  const flatten = (x: Cond) => {
    if (x.type === "and") {
      flatten(x.left);
      flatten(x.right);
    } else if (x.type === "or" || x.type === "not" || x.type === "in") {
      throw validation(`Invalid operator used in KeyConditionExpression: ${x.type.toUpperCase()}`);
    } else parts.push(x);
  };
  flatten(c);
  if (parts.length > 2) throw validation("KeyConditionExpressions must only contain one condition per key");
  const nameOf = (x: Cond): string => {
    const o = x.type === "cmp" ? (x.left.type === "path" ? x.left : x.right) : x.type === "between" ? x.operand : x.type === "fn" ? x.args[0] : undefined;
    if (!o || o.type !== "path" || o.path.length !== 1) throw validation("Query key condition not supported");
    return String(o.path[0]);
  };
  const valueOf = (o: Operand) => (o.type === "value" ? ctx.values![o.name] : undefined);
  let partition: KeyCondition["partition"] | undefined;
  let sort: KeyCondition["sort"];
  for (const p of parts) {
    const name = nameOf(p);
    if (name !== key.partition && name !== key.sort) throw validation("Query key condition not supported");
    if (name === key.partition) {
      if (p.type !== "cmp" || p.op !== "=") throw validation("Query key condition not supported");
      const v = valueOf(p.left.type === "value" ? p.left : p.right);
      if (!v) throw validation("Query key condition not supported");
      if (partition) throw validation("KeyConditionExpressions must only contain one condition per key");
      partition = { name, value: v };
    } else {
      if (sort) throw validation("KeyConditionExpressions must only contain one condition per key");
      if (p.type === "cmp" && p.op !== "<>") {
        const flipped = p.left.type === "value";
        const v = valueOf(flipped ? p.left : p.right);
        if (!v) throw validation("Query key condition not supported");
        const op = (flipped ? ({ "<": ">", ">": "<", "<=": ">=", ">=": "<=", "=": "=" } as Record<string, string>)[p.op] : p.op) as "=";
        sort = { name, op, values: [v] };
      } else if (p.type === "between") {
        const lo = valueOf(p.low);
        const hi = valueOf(p.high);
        if (!lo || !hi) throw validation("Query key condition not supported");
        const d = compare(lo, hi);
        if (d !== null && d > 0) throw validation(`Invalid KeyConditionExpression: The BETWEEN operator requires upper bound to be greater than or equal to lower bound; lower bound operand: AttributeValue: {${typeOf(lo)}:${Object.values(lo)[0]}}, upper bound operand: AttributeValue: {${typeOf(hi)}:${Object.values(hi)[0]}}`);
        sort = { name, op: "BETWEEN", values: [lo, hi] };
      } else if (p.type === "fn" && p.name === "begins_with") {
        const v = valueOf(p.args[1]);
        if (!v) throw validation("Query key condition not supported");
        sort = { name, op: "begins_with", values: [v] };
      } else {
        throw validation(`Invalid operator used in KeyConditionExpression: ${p.type === "fn" ? p.name : p.type === "cmp" ? p.op : p.type}`);
      }
    }
  }
  if (!partition) throw validation(`Query condition missed key schema element: ${key.partition}`);
  return { partition, sort };
}

export function sortMatches(cond: KeyCondition["sort"], v: AttributeValue | undefined): boolean {
  if (!cond) return true;
  if (!v) return false;
  const [a, b] = cond.values;
  if (cond.op === "begins_with") return "S" in v && "S" in a ? v.S.startsWith(a.S) : "B" in v && "B" in a ? v.B.startsWith(a.B) : false;
  const d = compare(v, a);
  if (d === null) return false;
  if (cond.op === "BETWEEN") {
    const e = compare(v, b);
    return e !== null && d >= 0 && e <= 0;
  }
  return { "=": d === 0, "<": d < 0, "<=": d <= 0, ">": d > 0, ">=": d >= 0 }[cond.op];
}

// ---------- projections ----------

export function parseProjection(src: string, ctx: ExprContext): PathPart[][] {
  const p = new Parser(tokenize(src, "ProjectionExpression"), src, "ProjectionExpression", ctx);
  const paths = [p.path()];
  while (p.peek().text === ",") {
    p.next();
    paths.push(p.path());
  }
  if (!p.atEnd()) p.syntax();
  return paths;
}

export function project(item: Item, paths: PathPart[][]): Item {
  const out: Item = {};
  for (const path of paths) {
    const v = getPath(item, path);
    if (v === undefined) continue;
    // Top-level attributes are copied as they are; nested ones keep their outer shape.
    if (path.length === 1) out[path[0] as string] = v;
    else setPath(out, path, v);
  }
  return out;
}

// ---------- update expressions ----------

type UpdateValue = { type: "operand"; operand: Operand } | { type: "arith"; op: "+" | "-"; left: Operand; right: Operand } | { type: "fn"; name: "if_not_exists" | "list_append"; args: Operand[] };

export interface UpdateAction {
  clause: "SET" | "REMOVE" | "ADD" | "DELETE";
  path: PathPart[];
  value?: UpdateValue;
  operand?: Operand;
}

export function parseUpdate(src: string, ctx: ExprContext): UpdateAction[] {
  const kind: ExprKind = "UpdateExpression";
  if (!src.trim()) throw validation("Invalid UpdateExpression: The expression can not be empty;");
  const p = new Parser(tokenize(src, kind), src, kind, ctx);
  const actions: UpdateAction[] = [];
  const seen = new Set<string>();
  const valueTerm = (): UpdateValue => {
    const t = p.peek();
    if (t.kind === "name" && (t.text === "if_not_exists" || t.text === "list_append") && p.ahead() === "(") {
      p.next();
      p.expect("(");
      const a = p.operand();
      p.expect(",");
      const b = p.operand();
      p.expect(")");
      return { type: "fn", name: t.text as "if_not_exists", args: [a, b] };
    }
    return { type: "operand", operand: p.operand() };
  };
  while (!p.atEnd()) {
    const t = p.next();
    const clause = t.text.toUpperCase();
    if (t.kind !== "name" || !["SET", "REMOVE", "ADD", "DELETE"].includes(clause)) p.syntax(t);
    if (seen.has(clause)) throw validation(`Invalid UpdateExpression: The "${clause}" section can only be used once in an update expression;`);
    seen.add(clause);
    for (;;) {
      const path = p.path();
      if (clause === "SET") {
        p.expect("=");
        const first = valueTerm();
        const op = p.peek();
        if (op.kind === "op" && (op.text === "+" || op.text === "-")) {
          p.next();
          const right = valueTerm();
          if (first.type !== "operand" || right.type !== "operand") throw validation("Invalid UpdateExpression: Syntax error; CloudLab supports + and - between plain values");
          actions.push({ clause: "SET", path, value: { type: "arith", op: op.text as "+", left: first.operand, right: right.operand } });
        } else actions.push({ clause: "SET", path, value: first });
      } else if (clause === "REMOVE") {
        actions.push({ clause: "REMOVE", path });
      } else {
        actions.push({ clause: clause as "ADD", path, operand: p.operand() });
      }
      if (p.peek().text === ",") {
        p.next();
        continue;
      }
      break;
    }
  }
  // Two actions on the same attribute aren't allowed.
  const keys = actions.map((a) => JSON.stringify(a.path));
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw validation(`Invalid UpdateExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [${JSON.parse(dup).join(", ")}], path two: [${JSON.parse(dup).join(", ")}]`);
  return actions;
}

function setPath(item: Item, path: PathPart[], value: AttributeValue) {
  if (path.length === 1) {
    item[path[0] as string] = value;
    return;
  }
  let parent: AttributeValue | undefined = item[path[0] as string];
  for (const part of path.slice(1, -1)) {
    if (!parent) break;
    parent = typeof part === "number" ? ("L" in parent ? parent.L[part] : undefined) : "M" in parent ? parent.M[part] : undefined;
  }
  const last = path[path.length - 1];
  if (!parent) {
    if (path.length === 2 && typeof last === "string") {
      item[path[0] as string] = { M: { [last]: value } };
      return;
    }
    throw validation("The document path provided in the update expression is invalid for update");
  }
  if (typeof last === "number" && "L" in parent) {
    if (last >= parent.L.length) parent.L.push(value);
    else parent.L[last] = value;
  } else if (typeof last === "string" && "M" in parent) parent.M[last] = value;
  else throw validation("The document path provided in the update expression is invalid for update");
}

function removePath(item: Item, path: PathPart[]) {
  if (path.length === 1) {
    delete item[path[0] as string];
    return;
  }
  const parent = getPath(item, path.slice(0, -1));
  const last = path[path.length - 1];
  if (!parent) return;
  if (typeof last === "number" && "L" in parent) parent.L.splice(last, 1);
  else if (typeof last === "string" && "M" in parent) delete parent.M[last];
}

const num = (v: AttributeValue | undefined): number => {
  if (!v || !("N" in v)) throw validation("An operand in the update expression has an incorrect data type");
  return Number(v.N);
};

/** Applies update actions to a copy of the item (or a new item made of the key). */
export function applyUpdate(item: Item, actions: UpdateAction[], ctx: ExprContext): Item {
  const out: Item = structuredClone(item);
  const val = (o: Operand) => operandValue(item, o, ctx);
  for (const a of actions) {
    if (a.clause === "SET") {
      const v = a.value!;
      let result: AttributeValue | undefined;
      if (v.type === "operand") result = val(v.operand);
      else if (v.type === "arith") {
        const l = val(v.left);
        const r = val(v.right);
        if (!l || !r) throw validation("The provided expression refers to an attribute that does not exist in the item");
        const n = v.op === "+" ? num(l) + num(r) : num(l) - num(r);
        result = { N: String(n) };
      } else if (v.name === "if_not_exists") {
        result = val(v.args[0]) ?? val(v.args[1]);
      } else {
        const l = val(v.args[0]);
        const r = val(v.args[1]);
        if (!l || !r || !("L" in l) || !("L" in r)) throw validation("An operand in the update expression has an incorrect data type");
        result = { L: [...l.L, ...r.L] };
      }
      if (!result) throw validation("The provided expression refers to an attribute that does not exist in the item");
      setPath(out, a.path, result);
    } else if (a.clause === "REMOVE") {
      removePath(out, a.path);
    } else {
      const operand = val(a.operand!)!;
      const current = getPath(out, a.path);
      if (a.clause === "ADD") {
        if ("N" in operand) {
          if (current && !("N" in current)) throw validation("An operand in the update expression has an incorrect data type");
          setPath(out, a.path, { N: String((current ? Number((current as { N: string }).N) : 0) + Number(operand.N)) });
        } else if ("SS" in operand || "NS" in operand || "BS" in operand) {
          const t = typeOf(operand);
          if (current && typeOf(current) !== t) throw validation("An operand in the update expression has an incorrect data type");
          const merged = [...new Set([...((current ? Object.values(current)[0] : []) as string[]), ...(Object.values(operand)[0] as string[])])];
          setPath(out, a.path, { [t]: merged } as AttributeValue);
        } else throw validation("Invalid UpdateExpression: Incorrect operand type for operator or function; operator: ADD, operand type: " + typeOf(operand));
      } else {
        if (!("SS" in operand || "NS" in operand || "BS" in operand)) throw validation("Invalid UpdateExpression: Incorrect operand type for operator or function; operator: DELETE, operand type: " + typeOf(operand));
        if (!current) continue;
        const t = typeOf(operand);
        const left = (Object.values(current)[0] as string[]).filter((x) => !(Object.values(operand)[0] as string[]).includes(x));
        if (left.length) setPath(out, a.path, { [t]: left } as AttributeValue);
        else removePath(out, a.path);
      }
    }
  }
  return out;
}

/** After parsing every expression of a request: placeholders given but never used are an error. */
export function checkUnused(ctx: ExprContext) {
  const unusedV = Object.keys(ctx.values ?? {}).filter((k) => !ctx.usedValues.has(k));
  if (unusedV.length) throw validation(`Value provided in ExpressionAttributeValues unused in expressions: keys: {${unusedV.join(", ")}}`);
  const unusedN = Object.keys(ctx.names ?? {}).filter((k) => !ctx.usedNames.has(k));
  if (unusedN.length) throw validation(`Value provided in ExpressionAttributeNames unused in expressions: keys: {${unusedN.join(", ")}}`);
}

export const newContext = (names?: Record<string, string>, values?: Record<string, AttributeValue>): ExprContext => ({ names, values, usedNames: new Set(), usedValues: new Set() });
