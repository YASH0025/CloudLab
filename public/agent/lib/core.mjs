// Generated from src/local/agent-core.ts by `npm run agent:core`. Don't edit by hand.
// src/engine/errors.ts
var EngineError = class extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.name = "EngineError";
  }
};

// node_modules/nanoid/url-alphabet/index.js
var urlAlphabet = "57X6y3wQZNzYjJB2L_10pxbackgroundhimselfUTF-8DEMOGRAPHICSVqvt4KW9";

// node_modules/nanoid/index.js
var GET_RANDOM_LIMIT = 65536;
function fillRandom(buffer) {
  let from = 0;
  while (from < buffer.length) {
    let to = Math.min(from + GET_RANDOM_LIMIT, buffer.length);
    crypto.getRandomValues(buffer.subarray(from, to));
    from = to;
  }
}
function random(bytes) {
  bytes |= 0;
  if (bytes < 0) throw new RangeError("Wrong ID size");
  let buffer = Buffer.allocUnsafe(bytes);
  fillRandom(buffer);
  return buffer;
}
function customRandom(alphabet, defaultSize, getRandom) {
  let safeByteCutoff = 256 - 256 % alphabet.length;
  if (safeByteCutoff === 256) {
    let mask = alphabet.length - 1;
    return (size = defaultSize) => {
      if (!size) return "";
      let id = "";
      while (true) {
        let bytes = getRandom(size);
        let i = size |= 0;
        while (i--) {
          id += alphabet[bytes[i] & mask];
          if (id.length >= size) return id;
        }
      }
    };
  }
  return (size = defaultSize) => {
    if (!size) return "";
    let id = "";
    let step = Math.ceil(1.6 * 256 * size / safeByteCutoff);
    while (true) {
      let bytes = getRandom(step);
      let i = step;
      while (i--) {
        if (bytes[i] < safeByteCutoff) {
          id += alphabet[bytes[i] % alphabet.length];
          if (id.length >= size) return id;
        }
      }
    }
  };
}
var POOL_MAX = GET_RANDOM_LIMIT / 2;
function customAlphabet(alphabet, defaultSize = 21) {
  if (typeof alphabet !== "string" || !alphabet || alphabet.length > 256) {
    return customRandom(alphabet, defaultSize, random);
  }
  for (let i = 0; i < alphabet.length; i++) {
    if (alphabet.charCodeAt(i) > 255) {
      return customRandom(alphabet, defaultSize, random);
    }
  }
  let charCodes = Uint8Array.from(alphabet, (str3) => {
    return str3.charCodeAt(0);
  });
  let alphabetLen = alphabet.length;
  let mask = (2 << 31 - Math.clz32(alphabetLen - 1 | 1)) - 1;
  let pool = "";
  let poolOffset = 0;
  let poolNext = 0;
  return (size = defaultSize) => {
    size |= 0;
    if (size < 0) throw new RangeError("Wrong ID size");
    if (size === 0) return "";
    if (poolOffset + size > pool.length) {
      let target = Math.max(poolNext, size);
      poolNext = Math.min(target * 16, POOL_MAX);
      let buffer = Buffer.allocUnsafe(target);
      if (mask === alphabetLen - 1) {
        fillRandom(buffer);
        for (let i = 0; i < target; i++) {
          buffer[i] = charCodes[buffer[i] & mask];
        }
      } else {
        let randomBytes2 = Buffer.allocUnsafe(
          Math.ceil(1.6 * (mask + 1) * target / alphabetLen)
        );
        let accepted = 0;
        while (accepted < target) {
          fillRandom(randomBytes2);
          for (let i = 0; i < randomBytes2.length; i++) {
            let index = randomBytes2[i] & mask;
            if (index < alphabetLen) {
              buffer[accepted++] = charCodes[index];
              if (accepted === target) break;
            }
          }
        }
      }
      pool = buffer.toString("latin1");
      poolOffset = 0;
    }
    poolOffset += size;
    return pool.substring(poolOffset - size, poolOffset);
  };
}
var nanoid = customAlphabet(urlAlphabet);

// src/engine/ids.ts
var hex = customAlphabet("0123456789abcdef", 17);
var upper = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 17);
function accountNumber(accountId) {
  let h = 0;
  for (const ch of accountId) h = h * 31 + ch.charCodeAt(0) >>> 0;
  return String(1e11 + h % 9e11).padStart(12, "0");
}

// src/engine/services/dynamodb.ts
var tableNotFound = (name) => new EngineError("ResourceNotFoundException", `Requested resource not found: Table: ${name} not found`, 400);
var tableKey = (t) => ({
  partition: { name: String(t.config.partitionKey), type: String(t.config.partitionKeyType) },
  ...t.config.sortKey ? { sort: { name: String(t.config.sortKey), type: String(t.config.sortKeyType ?? "S") } } : {}
});
var indexesOf = (t) => (t.config.globalSecondaryIndexes ?? []).map((g) => ({
  name: String(g.indexName),
  partition: { name: String(g.partitionKey), type: String(g.partitionKeyType ?? "S") },
  ...g.sortKey ? { sort: { name: String(g.sortKey), type: String(g.sortKeyType ?? "S") } } : {}
}));
var keyFields = (t) => {
  const key = tableKey(t);
  return [
    { AttributeName: key.partition.name, KeyType: "HASH" },
    ...key.sort ? [{ AttributeName: key.sort.name, KeyType: "RANGE" }] : []
  ];
};
function describeTable(t, status) {
  const key = tableKey(t);
  const defs = /* @__PURE__ */ new Map([[key.partition.name, key.partition.type]]);
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
    ...provisioned ? {} : { BillingModeSummary: { BillingMode: "PAY_PER_REQUEST", LastUpdateToPayPerRequestDateTime: t.createdAt } },
    ...gsis.length ? {
      GlobalSecondaryIndexes: gsis.map((g) => ({
        IndexName: g.name,
        KeySchema: [{ AttributeName: g.partition.name, KeyType: "HASH" }, ...g.sort ? [{ AttributeName: g.sort.name, KeyType: "RANGE" }] : []],
        Projection: { ProjectionType: "ALL" },
        IndexStatus: "ACTIVE",
        ProvisionedThroughput: throughput,
        IndexArn: `${t.id}/index/${g.name}`
      }))
    } : {},
    DeletionProtectionEnabled: t.config.deletionProtection === true
  };
}

// src/engine/catalog.ts
var LOCAL_REGION = "local-1";

// src/engine/dynamodb/values.ts
var validation = (message) => new EngineError("ValidationException", message, 400);
var TYPES = ["S", "N", "B", "BOOL", "NULL", "L", "M", "SS", "NS", "BS"];
var typeOf = (v) => Object.keys(v)[0];
var NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
function checkValue(v, where) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw validation(`Supplied AttributeValue is empty, must contain exactly one of the supported datatypes`);
  const keys = Object.keys(v);
  if (keys.length !== 1 || !TYPES.includes(keys[0])) {
    if (keys.length > 1) throw validation(`Supplied AttributeValue has more than one datatypes set, must contain exactly one of the supported datatypes`);
    throw validation(`Supplied AttributeValue is empty, must contain exactly one of the supported datatypes`);
  }
  const t = keys[0];
  const val = v[t];
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
      if (t === "NS") {
        for (const n of val) if (typeof n !== "string" || !NUMBER.test(n)) throw validation(`The parameter cannot be converted to a numeric value: ${String(n)}`);
      }
      if (new Set(val.map(String)).size !== val.length) throw validation(`One or more parameter values were invalid: Input collection [${val.join(", ")}] contains duplicates.`);
      break;
    }
  }
  return v;
}
function checkItem(item, where = "Item") {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw validation(`1 validation error detected: Value null at '${where.toLowerCase()}' failed to satisfy constraint: Member must not be null`);
  for (const [k, v] of Object.entries(item)) {
    if (k.length === 0) throw validation("One or more parameter values were invalid: An AttributeValue may not contain an empty attribute name");
    checkValue(v, k);
  }
  return item;
}
function compare(a, b) {
  const ta = typeOf(a);
  if (ta !== typeOf(b)) return null;
  if (ta === "N") return Number(a.N) - Number(b.N);
  if (ta === "S" || ta === "B") {
    const x = Buffer.from(a.S ?? a.B);
    const y = Buffer.from(b.S ?? b.B);
    return Buffer.compare(x, y);
  }
  return null;
}
function equal(a, b) {
  if (!a || !b) return false;
  const t = typeOf(a);
  if (t !== typeOf(b)) return false;
  if (t === "N") return Number(a.N) === Number(b.N);
  if (t === "SS" || t === "NS" || t === "BS") {
    const x = [...Object.values(a)[0]].map(String).sort();
    const y = [...Object.values(b)[0]].map(String).sort();
    return t === "NS" ? x.length === y.length && x.every((v, i) => Number(v) === Number(y[i])) : JSON.stringify(x) === JSON.stringify(y);
  }
  if (t === "L") {
    const x = a.L;
    const y = b.L;
    return x.length === y.length && x.every((v, i) => equal(v, y[i]));
  }
  if (t === "M") {
    const x = a.M;
    const y = b.M;
    const kx = Object.keys(x).sort();
    return JSON.stringify(kx) === JSON.stringify(Object.keys(y).sort()) && kx.every((k) => equal(x[k], y[k]));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
var sizes = /* @__PURE__ */ new WeakMap();
function itemSize(item) {
  const known = sizes.get(item);
  if (known !== void 0) return known;
  const total = measure(item);
  sizes.set(item, total);
  return total;
}
function measure(item) {
  const size = (v) => {
    const t = typeOf(v);
    const val = Object.values(v)[0];
    if (t === "S" || t === "B") return Buffer.byteLength(String(val));
    if (t === "N") return Math.ceil(String(val).replace(/^[-+]/, "").length / 2) + 1;
    if (t === "BOOL" || t === "NULL") return 1;
    if (t === "L") return 3 + val.reduce((n, x) => n + 1 + size(x), 0);
    if (t === "M") return 3 + Object.entries(val).reduce((n, [k, x]) => n + 1 + Buffer.byteLength(k) + size(x), 0);
    return val.reduce((n, x) => n + Buffer.byteLength(x), 0);
  };
  return Object.entries(item).reduce((n, [k, v]) => n + Buffer.byteLength(k) + size(v), 0);
}
function marshall(value) {
  if (value === null || value === void 0) return { NULL: true };
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
var marshallItem = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, marshall(v)]));
function unmarshall(v) {
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
      return val.map(unmarshall);
    case "M":
      return Object.fromEntries(Object.entries(val).map(([k, x]) => [k, unmarshall(x)]));
    case "NS":
      return val.map(Number);
    default:
      return val;
  }
}
var unmarshallItem = (item) => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, unmarshall(v)]));

// src/engine/dynamodb/expressions.ts
var RESERVED = new Set(
  "ABORT ABSOLUTE ACTION ADD AFTER AGENT AGGREGATE ALL ALLOCATE ALTER ANALYZE AND ANY ARCHIVE ARE ARRAY AS ASC ASCII ASENSITIVE ASSERTION ASYMMETRIC AT ATOMIC ATTACH ATTRIBUTE AUTH AUTHORIZATION AUTHORIZE AUTO AVG BACK BACKUP BASE BATCH BEFORE BEGIN BETWEEN BIGINT BINARY BIT BLOB BLOCK BOOLEAN BOTH BREADTH BUCKET BULK BY BYTE CALL CALLED CALLING CAPACITY CASCADE CASCADED CASE CAST CATALOG CHAR CHARACTER CHECK CLASS CLOB CLOSE CLUSTER CLUSTERED CLUSTERING CLUSTERS COALESCE COLLATE COLLATION COLLECTION COLUMN COLUMNS COMBINE COMMENT COMMIT COMPACT COMPILE COMPRESS CONDITION CONFLICT CONNECT CONNECTION CONSISTENCY CONSISTENT CONSTRAINT CONSTRAINTS CONSTRUCTOR CONSUMED CONTINUE CONVERT COPY CORRESPONDING COUNT COUNTER CREATE CROSS CUBE CURRENT CURSOR CYCLE DATA DATABASE DATE DATETIME DAY DEALLOCATE DEC DECIMAL DECLARE DEFAULT DEFERRABLE DEFERRED DEFINE DEFINED DEFINITION DELETE DELIMITED DEPTH DEREF DESC DESCRIBE DESCRIPTOR DETACH DETERMINISTIC DIAGNOSTICS DIRECTORIES DISABLE DISCONNECT DISTINCT DISTRIBUTE DO DOMAIN DOUBLE DROP DUMP DURATION DYNAMIC EACH ELEMENT ELSE ELSEIF EMPTY ENABLE END EQUAL EQUALS ERROR ESCAPE ESCAPED EVAL EVALUATE EXCEEDED EXCEPT EXCEPTION EXCEPTIONS EXCLUSIVE EXEC EXECUTE EXISTS EXIT EXPLAIN EXPLODE EXPORT EXPRESSION EXTENDED EXTERNAL EXTRACT FAIL FALSE FAMILY FETCH FIELDS FILE FILTER FILTERING FINAL FINISH FIRST FIXED FLATTERN FLOAT FOR FORCE FOREIGN FORMAT FORWARD FOUND FREE FROM FULL FUNCTION FUNCTIONS GENERAL GENERATE GET GLOB GLOBAL GO GOTO GRANT GREATER GROUP GROUPING HANDLER HASH HAVE HAVING HEAP HIDDEN HOLD HOUR IDENTIFIED IDENTITY IF IGNORE IMMEDIATE IMPORT IN INCLUDING INCLUSIVE INCREMENT INCREMENTAL INDEX INDEXED INDEXES INDICATOR INFINITE INITIALLY INLINE INNER INNTER INOUT INPUT INSENSITIVE INSERT INSTEAD INT INTEGER INTERSECT INTERVAL INTO INVALIDATE IS ISOLATION ITEM ITEMS ITERATE JOIN KEY KEYS LAG LANGUAGE LARGE LAST LATERAL LEAD LEADING LEAVE LEFT LENGTH LESS LEVEL LIKE LIMIT LIMITED LINES LIST LOAD LOCAL LOCALTIME LOCALTIMESTAMP LOCATION LOCATOR LOCK LOCKS LOG LOGED LONG LOOP LOWER MAP MATCH MATERIALIZED MAX MAXLEN MEMBER MERGE METHOD METRICS MIN MINUS MINUTE MISSING MOD MODE MODIFIES MODIFY MODULE MONTH MULTI MULTISET NAME NAMES NATIONAL NATURAL NCHAR NCLOB NEW NEXT NO NONE NOT NULL NULLIF NUMBER NUMERIC OBJECT OF OFFLINE OFFSET OLD ON ONLINE ONLY OPAQUE OPEN OPERATOR OPTION OR ORDER ORDINALITY OTHER OTHERS OUT OUTER OUTPUT OVER OVERLAPS OVERRIDE OWNER PAD PARALLEL PARAMETER PARAMETERS PARTIAL PARTITION PARTITIONED PARTITIONS PATH PERCENT PERCENTILE PERMISSION PERMISSIONS PIPE PIPELINED PLAN POOL POSITION PRECISION PREPARE PRESERVE PRIMARY PRIOR PRIVATE PRIVILEGES PROCEDURE PROCESSED PROJECT PROJECTION PROPERTY PROVISIONING PUBLIC PUT QUERY QUIT QUORUM RAISE RANDOM RANGE RANK RAW READ READS REAL REBUILD RECORD RECURSIVE REDUCE REF REFERENCE REFERENCES REFERENCING REGEXP REGION REINDEX RELATIVE RELEASE REMAINDER RENAME REPEAT REPLACE REQUEST RESET RESIGNAL RESOURCE RESPONSE RESTORE RESTRICT RESULT RETURN RETURNING RETURNS REVERSE REVOKE RIGHT ROLE ROLES ROLLBACK ROLLUP ROUTINE ROW ROWS RULE RULES SAMPLE SATISFIES SAVE SAVEPOINT SCAN SCHEMA SCOPE SCROLL SEARCH SECOND SECTION SEGMENT SEGMENTS SELECT SELF SEMI SENSITIVE SEPARATE SEQUENCE SERIALIZABLE SESSION SET SETS SHARD SHARE SHARED SHORT SHOW SIGNAL SIMILAR SIZE SKEWED SMALLINT SNAPSHOT SOME SOURCE SPACE SPACES SPARSE SPECIFIC SPECIFICTYPE SPLIT SQL SQLCODE SQLERROR SQLEXCEPTION SQLSTATE SQLWARNING START STATE STATIC STATUS STORAGE STORE STORED STREAM STRING STRUCT STYLE SUB SUBMULTISET SUBPARTITION SUBSTRING SUBTYPE SUM SUPER SYMMETRIC SYNONYM SYSTEM TABLE TABLESAMPLE TEMP TEMPORARY TERMINATED TEXT THAN THEN THROUGHPUT TIME TIMESTAMP TIMEZONE TINYINT TO TOKEN TOTAL TOUCH TRAILING TRANSACTION TRANSFORM TRANSLATE TRANSLATION TREAT TRIGGER TRIM TRUE TRUNCATE TTL TUPLE TYPE UNDER UNDO UNION UNIQUE UNIT UNKNOWN UNLOGGED UNNEST UNPROCESSED UNSIGNED UNTIL UPDATE UPPER URL USAGE USE USER USERS USING UUID VACUUM VALUE VALUED VALUES VARCHAR VARIABLE VARIANCE VARINT VARYING VIEW VIEWS VIRTUAL VOID WAIT WHEN WHENEVER WHERE WHILE WINDOW WITH WITHIN WITHOUT WORK WRAPPED WRITE YEAR ZONE".split(" ")
);
function tokenize(src, kind) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const rest = src.slice(i);
    const m = /^#[A-Za-z0-9_]+/.exec(rest) ?? /^:[A-Za-z0-9_]+/.exec(rest) ?? /^[A-Za-z_][A-Za-z0-9_-]*/.exec(rest) ?? /^\d+/.exec(rest) ?? /^(<=|>=|<>|=|<|>|\+|-)/.exec(rest) ?? /^[(),.[\]]/.exec(rest);
    if (!m) throw validation(`Invalid ${kind}: Syntax error; token: "${ch}", near: "${src.slice(Math.max(0, i - 5), i + 5)}"`);
    const t = m[0];
    const k = t.startsWith("#") ? "hashName" : t.startsWith(":") ? "value" : /^\d/.test(t) ? "number" : /^[A-Za-z_]/.test(t) ? "name" : /^[(),.[\]]$/.test(t) ? "punct" : "op";
    out.push({ kind: k, text: t, pos: i });
    i += t.length;
  }
  out.push({ kind: "end", text: "<EOF>", pos: src.length });
  return out;
}
var Parser = class {
  constructor(tokens, src, kind, ctx) {
    this.tokens = tokens;
    this.src = src;
    this.kind = kind;
    this.ctx = ctx;
    this.i = 0;
  }
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
  isKw(word, t = this.peek()) {
    return t.kind === "name" && t.text.toUpperCase() === word;
  }
  syntax(t = this.peek()) {
    const near = this.src.slice(Math.max(0, t.pos - 6), t.pos + t.text.length + 6).trim();
    throw validation(`Invalid ${this.kind}: Syntax error; token: "${t.text}", near: "${near}"`);
  }
  expect(text) {
    const t = this.next();
    if (t.text !== text) this.syntax(t);
  }
  atEnd() {
    return this.peek().kind === "end";
  }
  /** a.b[0].#c */
  path() {
    const parts = [this.nameSegment()];
    for (; ; ) {
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
  nameSegment() {
    const t = this.next();
    if (t.kind === "hashName") {
      this.ctx.usedNames.add(t.text);
      const real = this.ctx.names?.[t.text];
      if (real === void 0) throw validation(`Invalid ${this.kind}: An expression attribute name used in the document path is not defined; attribute name: ${t.text}`);
      return real;
    }
    if (t.kind === "name") {
      if (RESERVED.has(t.text.toUpperCase())) throw validation(`Invalid ${this.kind}: Attribute name is a reserved keyword; reserved keyword: ${t.text}`);
      return t.text;
    }
    return this.syntax(t);
  }
  operand() {
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
  condition() {
    let left = this.andCond();
    while (this.isKw("OR")) {
      this.next();
      left = { type: "or", left, right: this.andCond() };
    }
    return left;
  }
  andCond() {
    let left = this.notCond();
    while (this.isKw("AND")) {
      this.next();
      left = { type: "and", left, right: this.notCond() };
    }
    return left;
  }
  notCond() {
    if (this.isKw("NOT")) {
      this.next();
      return { type: "not", cond: this.notCond() };
    }
    return this.primary();
  }
  primary() {
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
      const args = [this.operand()];
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
      const list2 = [this.operand()];
      while (this.peek().text === ",") {
        this.next();
        list2.push(this.operand());
      }
      this.expect(")");
      return { type: "in", operand: left, list: list2 };
    }
    return this.syntax(op);
  }
};
function parseCondition(src, kind, ctx) {
  if (!src.trim()) throw validation(`Invalid ${kind}: The expression can not be empty;`);
  const p = new Parser(tokenize(src, kind), src, kind, ctx);
  const c = p.condition();
  if (!p.atEnd()) p.syntax();
  return c;
}
function getPath(item, path2) {
  let cur = item[path2[0]];
  for (const part of path2.slice(1)) {
    if (!cur) return void 0;
    if (typeof part === "number") cur = "L" in cur ? cur.L[part] : void 0;
    else cur = "M" in cur ? cur.M[part] : void 0;
  }
  return cur;
}
function operandValue(item, o, ctx) {
  if (o.type === "value") return ctx.values[o.name];
  if (o.type === "path") return getPath(item, o.path);
  const v = getPath(item, o.path);
  if (!v) return void 0;
  const t = typeOf(v);
  const val = Object.values(v)[0];
  const n = t === "S" || t === "B" ? Buffer.byteLength(String(val)) : t === "M" ? Object.keys(val).length : Array.isArray(val) ? val.length : void 0;
  return n === void 0 ? void 0 : { N: String(n) };
}
function evaluate(c, item, ctx) {
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
      if (c.name === "attribute_exists") return v !== void 0;
      if (c.name === "attribute_not_exists") return v === void 0;
      const arg = operandValue(item, c.args[1], ctx);
      if (c.name === "attribute_type") return !!v && !!arg && "S" in arg && typeOf(v) === arg.S;
      if (!v || !arg) return false;
      if (c.name === "begins_with") return "S" in v && "S" in arg && v.S.startsWith(arg.S) || "B" in v && "B" in arg && v.B.startsWith(arg.B);
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
function parseKeyCondition(src, ctx, key) {
  const kind = "KeyConditionExpression";
  const c = parseCondition(src, kind, ctx);
  const parts = [];
  const flatten = (x) => {
    if (x.type === "and") {
      flatten(x.left);
      flatten(x.right);
    } else if (x.type === "or" || x.type === "not" || x.type === "in") {
      throw validation(`Invalid operator used in KeyConditionExpression: ${x.type.toUpperCase()}`);
    } else parts.push(x);
  };
  flatten(c);
  if (parts.length > 2) throw validation("KeyConditionExpressions must only contain one condition per key");
  const nameOf = (x) => {
    const o = x.type === "cmp" ? x.left.type === "path" ? x.left : x.right : x.type === "between" ? x.operand : x.type === "fn" ? x.args[0] : void 0;
    if (!o || o.type !== "path" || o.path.length !== 1) throw validation("Query key condition not supported");
    return String(o.path[0]);
  };
  const valueOf = (o) => o.type === "value" ? ctx.values[o.name] : void 0;
  let partition;
  let sort;
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
        const op = flipped ? { "<": ">", ">": "<", "<=": ">=", ">=": "<=", "=": "=" }[p.op] : p.op;
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
function sortMatches(cond, v) {
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
function parseProjection(src, ctx) {
  const p = new Parser(tokenize(src, "ProjectionExpression"), src, "ProjectionExpression", ctx);
  const paths = [p.path()];
  while (p.peek().text === ",") {
    p.next();
    paths.push(p.path());
  }
  if (!p.atEnd()) p.syntax();
  return paths;
}
function project(item, paths) {
  const out = {};
  for (const path2 of paths) {
    const v = getPath(item, path2);
    if (v === void 0) continue;
    if (path2.length === 1) out[path2[0]] = v;
    else setPath(out, path2, v);
  }
  return out;
}
function parseUpdate(src, ctx) {
  const kind = "UpdateExpression";
  if (!src.trim()) throw validation("Invalid UpdateExpression: The expression can not be empty;");
  const p = new Parser(tokenize(src, kind), src, kind, ctx);
  const actions = [];
  const seen = /* @__PURE__ */ new Set();
  const valueTerm = () => {
    const t = p.peek();
    if (t.kind === "name" && (t.text === "if_not_exists" || t.text === "list_append") && p.ahead() === "(") {
      p.next();
      p.expect("(");
      const a = p.operand();
      p.expect(",");
      const b = p.operand();
      p.expect(")");
      return { type: "fn", name: t.text, args: [a, b] };
    }
    return { type: "operand", operand: p.operand() };
  };
  while (!p.atEnd()) {
    const t = p.next();
    const clause = t.text.toUpperCase();
    if (t.kind !== "name" || !["SET", "REMOVE", "ADD", "DELETE"].includes(clause)) p.syntax(t);
    if (seen.has(clause)) throw validation(`Invalid UpdateExpression: The "${clause}" section can only be used once in an update expression;`);
    seen.add(clause);
    for (; ; ) {
      const path2 = p.path();
      if (clause === "SET") {
        p.expect("=");
        const first = valueTerm();
        const op = p.peek();
        if (op.kind === "op" && (op.text === "+" || op.text === "-")) {
          p.next();
          const right = valueTerm();
          if (first.type !== "operand" || right.type !== "operand") throw validation("Invalid UpdateExpression: Syntax error; CloudLab supports + and - between plain values");
          actions.push({ clause: "SET", path: path2, value: { type: "arith", op: op.text, left: first.operand, right: right.operand } });
        } else actions.push({ clause: "SET", path: path2, value: first });
      } else if (clause === "REMOVE") {
        actions.push({ clause: "REMOVE", path: path2 });
      } else {
        actions.push({ clause, path: path2, operand: p.operand() });
      }
      if (p.peek().text === ",") {
        p.next();
        continue;
      }
      break;
    }
  }
  const keys = actions.map((a) => JSON.stringify(a.path));
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw validation(`Invalid UpdateExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [${JSON.parse(dup).join(", ")}], path two: [${JSON.parse(dup).join(", ")}]`);
  return actions;
}
function setPath(item, path2, value) {
  if (path2.length === 1) {
    item[path2[0]] = value;
    return;
  }
  let parent = item[path2[0]];
  for (const part of path2.slice(1, -1)) {
    if (!parent) break;
    parent = typeof part === "number" ? "L" in parent ? parent.L[part] : void 0 : "M" in parent ? parent.M[part] : void 0;
  }
  const last = path2[path2.length - 1];
  if (!parent) {
    if (path2.length === 2 && typeof last === "string") {
      item[path2[0]] = { M: { [last]: value } };
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
function removePath(item, path2) {
  if (path2.length === 1) {
    delete item[path2[0]];
    return;
  }
  const parent = getPath(item, path2.slice(0, -1));
  const last = path2[path2.length - 1];
  if (!parent) return;
  if (typeof last === "number" && "L" in parent) parent.L.splice(last, 1);
  else if (typeof last === "string" && "M" in parent) delete parent.M[last];
}
var num = (v) => {
  if (!v || !("N" in v)) throw validation("An operand in the update expression has an incorrect data type");
  return Number(v.N);
};
function applyUpdate(item, actions, ctx) {
  const out = structuredClone(item);
  const val = (o) => operandValue(item, o, ctx);
  for (const a of actions) {
    if (a.clause === "SET") {
      const v = a.value;
      let result;
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
      const operand = val(a.operand);
      const current = getPath(out, a.path);
      if (a.clause === "ADD") {
        if ("N" in operand) {
          if (current && !("N" in current)) throw validation("An operand in the update expression has an incorrect data type");
          setPath(out, a.path, { N: String((current ? Number(current.N) : 0) + Number(operand.N)) });
        } else if ("SS" in operand || "NS" in operand || "BS" in operand) {
          const t = typeOf(operand);
          if (current && typeOf(current) !== t) throw validation("An operand in the update expression has an incorrect data type");
          const merged = [.../* @__PURE__ */ new Set([...current ? Object.values(current)[0] : [], ...Object.values(operand)[0]])];
          setPath(out, a.path, { [t]: merged });
        } else throw validation("Invalid UpdateExpression: Incorrect operand type for operator or function; operator: ADD, operand type: " + typeOf(operand));
      } else {
        if (!("SS" in operand || "NS" in operand || "BS" in operand)) throw validation("Invalid UpdateExpression: Incorrect operand type for operator or function; operator: DELETE, operand type: " + typeOf(operand));
        if (!current) continue;
        const t = typeOf(operand);
        const left = Object.values(current)[0].filter((x) => !Object.values(operand)[0].includes(x));
        if (left.length) setPath(out, a.path, { [t]: left });
        else removePath(out, a.path);
      }
    }
  }
  return out;
}
function checkUnused(ctx) {
  const unusedV = Object.keys(ctx.values ?? {}).filter((k) => !ctx.usedValues.has(k));
  if (unusedV.length) throw validation(`Value provided in ExpressionAttributeValues unused in expressions: keys: {${unusedV.join(", ")}}`);
  const unusedN = Object.keys(ctx.names ?? {}).filter((k) => !ctx.usedNames.has(k));
  if (unusedN.length) throw validation(`Value provided in ExpressionAttributeNames unused in expressions: keys: {${unusedN.join(", ")}}`);
}
var newContext = (names, values) => ({ names, values, usedNames: /* @__PURE__ */ new Set(), usedValues: /* @__PURE__ */ new Set() });

// src/engine/dynamodb/items.ts
var MAX_ITEM_BYTES = 400 * 1024;
var MAX_ITEMS = 2e3;
var MAX_TABLE_BYTES = 4 * 1024 * 1024;
var PAGE_BYTES = 1024 * 1024;
var statsOf = (t) => ({ reads: 0, writes: 0, queries: 0, scans: 0, throttled: 0, conditionalFailures: 0, indexQueries: 0, ...t.attributes.stats ?? {} });
var itemsOf = (t) => t.attributes.items ?? {};
var keyString = (key, item) => JSON.stringify([item[key.partition.name], key.sort ? item[key.sort.name] : null]);
function context(input) {
  if (input.names && Object.keys(input.names).length === 0) throw validation("ExpressionAttributeNames must not be empty");
  if (input.values && Object.keys(input.values).length === 0) throw validation("ExpressionAttributeValues must not be empty");
  for (const [k, v] of Object.entries(input.values ?? {})) {
    if (!k.startsWith(":")) throw validation(`ExpressionAttributeValues contains invalid key: Syntax error; key: "${k}"`);
    checkValue(v, k);
  }
  for (const k of Object.keys(input.names ?? {})) if (!k.startsWith("#")) throw validation(`ExpressionAttributeNames contains invalid key: Syntax error; key: "${k}"`);
  return newContext(input.names, input.values);
}
async function load(engine, table2) {
  const t = await engine.get(table2.accountId, table2.id).catch(() => null);
  if (!t) throw tableNotFound(table2.name);
  if (t.region === LOCAL_REGION && !engine.holdsLocalItems) {
    throw new EngineError(
      "LocalTable",
      `The items of ${t.name} are on your computer (My computer (local)), not on CloudLab's servers. Open the table in the console on that computer, or use an AWS SDK or the AWS CLI with the endpoint http://localhost:4566.`,
      400
    );
  }
  if (t.state === "CREATING") throw new EngineError("ResourceNotFoundException", "Requested resource not found", 400);
  const ttl = t.config.ttlAttribute ? String(t.config.ttlAttribute) : null;
  if (ttl) {
    const now = engine.now().getTime() / 1e3;
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
function totalsOf(t, items) {
  const count = t.attributes.itemCount;
  const bytes = t.attributes.tableSizeBytes;
  if (typeof count === "number" && typeof bytes === "number") return { count, bytes };
  return { count: Object.keys(items).length, bytes: Object.values(items).reduce((n, it) => n + itemSize(it), 0) };
}
async function save(engine, t, items, add = {}, totals) {
  const stats = statsOf(t);
  for (const [k, v] of Object.entries(add)) stats[k] += v ?? 0;
  const { count, bytes } = totals ?? { count: Object.keys(items).length, bytes: Object.values(items).reduce((n, it) => n + itemSize(it), 0) };
  await engine.setAttributes(t.accountId, t.id, { items, itemCount: count, tableSizeBytes: bytes, stats });
}
async function write(engine, t, items, k, item) {
  const before = totalsOf(t, items);
  const old = items[k];
  const totals = {
    count: before.count + (item ? 1 : 0) - (old ? 1 : 0),
    bytes: before.bytes + (item ? itemSize(item) : 0) - (old ? itemSize(old) : 0)
  };
  if (item) checkLimits(totals);
  if (item) items[k] = item;
  else delete items[k];
  await save(engine, t, items, { writes: 1 }, totals);
}
async function bump(engine, t, add) {
  const stats = statsOf(t);
  for (const [k, v] of Object.entries(add)) stats[k] += v ?? 0;
  await engine.setAttributes(t.accountId, t.id, { stats });
}
async function consume(engine, t, kind, units) {
  const dims = { TableName: t.name };
  const metric = kind === "read" ? "ConsumedReadCapacityUnits" : "ConsumedWriteCapacityUnits";
  if (t.config.billingMode === "PROVISIONED") {
    const limit = Number(kind === "read" ? t.config.readCapacity : t.config.writeCapacity);
    const used2 = await engine.countInWindow(`ddb-${kind}:${t.id}`, 1e3);
    if (used2 > limit) {
      await bump(engine, t, { throttled: 1 });
      await engine.setAttributes(t.accountId, t.id, { throttledAt: engine.now().toISOString() });
      await engine.metrics.record(t.accountId, t.region, "AWS/DynamoDB", kind === "read" ? "ReadThrottleEvents" : "WriteThrottleEvents", dims, 1, "Count");
      throw new EngineError(
        "ProvisionedThroughputExceededException",
        "The level of configured provisioned throughput for the table was exceeded. Consider increasing your provisioning level with the UpdateTable API.",
        400
      );
    }
  }
  await engine.metrics.record(t.accountId, t.region, "AWS/DynamoDB", metric, dims, units, "Count");
}
var readUnits = (bytes, consistent) => Math.max(1, Math.ceil(bytes / 4096)) * (consistent ? 1 : 0.5);
var writeUnits = (bytes) => Math.max(1, Math.ceil(bytes / 1024));
function checkKeyAttributes(t, item) {
  const key = tableKey(t);
  for (const k of [key.partition, ...key.sort ? [key.sort] : []]) {
    const v = item[k.name];
    if (!v) throw validation(`One or more parameter values were invalid: Missing the key ${k.name} in the item`);
    if (typeOf(v) !== k.type) throw validation(`One or more parameter values were invalid: Type mismatch for key ${k.name} expected: ${k.type} actual: ${typeOf(v)}`);
    if (Object.values(v)[0] === "") throw validation(`One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: ${k.name}`);
  }
  for (const idx of indexesOf(t)) {
    for (const k of [idx.partition, ...idx.sort ? [idx.sort] : []]) {
      const v = item[k.name];
      if (v && typeOf(v) !== k.type) throw validation(`One or more parameter values were invalid: Type mismatch for Index Key ${k.name} Expected: ${k.type} Actual: ${typeOf(v)} IndexName: ${idx.name}`);
      if (v && Object.values(v)[0] === "") throw validation(`One or more parameter values are not valid. A value specified for a secondary index key is not supported. The AttributeValue for a key attribute cannot contain an empty string value. IndexName: ${idx.name}, IndexKey: ${k.name}`);
    }
  }
}
function checkKey(t, keyInput) {
  const key = tableKey(t);
  const k = checkItem(keyInput, "Key");
  const want = [key.partition, ...key.sort ? [key.sort] : []];
  if (Object.keys(k).length !== want.length || want.some((w) => !k[w.name])) throw validation("The provided key element does not match the schema");
  for (const w of want) if (typeOf(k[w.name]) !== w.type) throw validation("The provided key element does not match the schema");
  return k;
}
function conditionCheck(t, existing, condition, ctx, returnOld) {
  if (!condition) return;
  const c = parseCondition(condition, "ConditionExpression", ctx);
  checkUnused(ctx);
  if (!evaluate(c, existing ?? {}, ctx)) {
    const e = new EngineError("ConditionalCheckFailedException", "The conditional request failed", 400);
    if (returnOld && existing) e.item = existing;
    throw e;
  }
}
async function failOnCondition(engine, t, fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof EngineError && e.code === "ConditionalCheckFailedException") await bump(engine, t, { conditionalFailures: 1 });
    throw e;
  }
}
function checkLimits(totals) {
  if (totals.count > MAX_ITEMS) throw new EngineError("LimitExceededException", `CloudLab keeps at most ${MAX_ITEMS} items per table. Delete some first.`, 400);
  if (totals.bytes > MAX_TABLE_BYTES) throw new EngineError("LimitExceededException", "CloudLab keeps at most 4 MB per table. Delete some items first.", 400);
}
async function putItem(engine, table2, itemInput, input = {}) {
  const t = await load(engine, table2);
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
  await write(engine, t, items, k, item);
  return rv === "ALL_OLD" && old ? { Attributes: old } : {};
}
async function getItem(engine, table2, keyInput, input = {}) {
  const t = await load(engine, table2);
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
async function deleteItem(engine, table2, keyInput, input = {}) {
  const t = await load(engine, table2);
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
  if (old) await write(engine, t, items, k, void 0);
  return rv === "ALL_OLD" && old ? { Attributes: old } : {};
}
async function updateItem(engine, table2, keyInput, input) {
  const t = await load(engine, table2);
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
  const updated = applyUpdate(old ?? key, actions, ctx);
  checkKeyAttributes(t, updated);
  const size = itemSize(updated);
  if (size > MAX_ITEM_BYTES) throw validation("Item size to update has exceeded the maximum allowed size");
  await consume(engine, t, "write", writeUnits(size));
  await write(engine, t, items, k, updated);
  const touched = new Set(actions.map((a) => String(a.path[0])));
  const pick = (it) => it ? Object.fromEntries(Object.entries(it).filter(([n]) => touched.has(n))) : void 0;
  const out = rv === "ALL_NEW" ? updated : rv === "UPDATED_NEW" ? pick(updated) : rv === "ALL_OLD" ? old : rv === "UPDATED_OLD" ? pick(old) : void 0;
  return out && Object.keys(out).length ? { Attributes: out } : {};
}
async function checkItemCondition(engine, table2, keyInput, input) {
  const t = await load(engine, table2);
  const key = checkKey(t, keyInput);
  const ctx = context(input);
  const existing = itemsOf(t)[keyString(tableKey(t), key)];
  await failOnCondition(engine, t, () => conditionCheck(t, existing, input.condition, ctx, false));
}
function keyOfItem(t, item, idx) {
  const key = tableKey(t);
  const names = [key.partition.name, key.sort?.name, idx?.partition.name, idx?.sort?.name].filter(Boolean);
  return Object.fromEntries(names.filter((n) => item[n]).map((n) => [n, item[n]]));
}
function page(t, candidates, input, ctx, kind, idx) {
  const filter = input.filter ? parseCondition(input.filter, "FilterExpression", ctx) : null;
  const paths = input.projection ? parseProjection(input.projection, ctx) : null;
  checkUnused(ctx);
  if (input.limit !== void 0 && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw validation(`1 validation error detected: Value '${input.limit}' at 'limit' failed to satisfy constraint: Member must have value greater than or equal to 1`);
  }
  let start = 0;
  if (input.exclusiveStartKey) {
    const want = JSON.stringify(keyOfItem(t, input.exclusiveStartKey, idx));
    const i = candidates.findIndex((it) => JSON.stringify(keyOfItem(t, it, idx)) === want);
    if (i === -1 && kind === "Query") throw validation("The provided starting key is invalid: The provided key element does not match the schema");
    start = i + 1;
  }
  const out = [];
  let scanned = 0;
  let bytes = 0;
  let last;
  for (let i = start; i < candidates.length; i++) {
    const it = candidates[i];
    scanned++;
    bytes += itemSize(it);
    if (!filter || evaluate(filter, it, ctx)) out.push(paths ? project(it, paths) : it);
    const stop = input.limit !== void 0 && scanned >= input.limit || bytes >= PAGE_BYTES;
    if (stop && i < candidates.length - 1) {
      last = keyOfItem(t, it, idx);
      break;
    }
  }
  return { out, scanned, bytes, last };
}
function sortItems(items, sortName, forward) {
  if (!sortName) return items;
  return [...items].sort((a, b) => {
    const d = compare(a[sortName], b[sortName]) ?? 0;
    return forward ? d : -d;
  });
}
async function query(engine, table2, input) {
  const t = await load(engine, table2);
  const ctx = context(input);
  let key = tableKey(t);
  if (input.indexName) {
    const idx = indexesOf(t).find((i) => i.name === input.indexName);
    if (!idx) throw validation(`The table does not have the specified index: ${input.indexName}`);
    if (input.consistentRead) throw validation("Consistent reads are not supported on global secondary indexes");
    key = idx;
  }
  if (!input.keyCondition) throw validation("Either the KeyConditions or KeyConditionExpression parameter must be specified in the request.");
  const kc = parseKeyCondition(input.keyCondition, ctx, { partition: key.partition.name, sort: key.sort?.name });
  if (typeOf(kc.partition.value) !== key.partition.type) throw validation("One or more parameter values were invalid: Condition parameter type does not match schema type");
  if (kc.sort && kc.sort.values.some((v) => typeOf(v) !== key.sort.type)) throw validation("One or more parameter values were invalid: Condition parameter type does not match schema type");
  if (kc.sort?.op === "begins_with" && key.sort?.type === "N") throw validation("Invalid KeyConditionExpression: Incorrect operand type for operator or function; operator or function: begins_with, operand type: N");
  const inPartition = Object.values(itemsOf(t)).filter((it) => {
    const pv = it[key.partition.name];
    return pv && JSON.stringify(pv) === JSON.stringify(kc.partition.value) && (!key.sort || it[key.sort.name]) && sortMatches(kc.sort, key.sort ? it[key.sort.name] : void 0);
  });
  const sorted = sortItems(inPartition, key.sort?.name, input.scanIndexForward !== false);
  const r = page(t, sorted, input, ctx, "Query", input.indexName ? key : void 0);
  await consume(engine, t, "read", readUnits(r.bytes, input.consistentRead === true));
  await bump(engine, t, { queries: 1, indexQueries: input.indexName ? 1 : 0 });
  await engine.metrics.record(t.accountId, t.region, "AWS/DynamoDB", "ReturnedItemCount", { TableName: t.name, Operation: "Query" }, r.out.length, "Count");
  return { ...input.select === "COUNT" ? {} : { Items: r.out }, Count: r.out.length, ScannedCount: r.scanned, ...r.last ? { LastEvaluatedKey: r.last } : {} };
}
async function scan(engine, table2, input = {}) {
  const t = await load(engine, table2);
  const ctx = context(input);
  let all = Object.values(itemsOf(t));
  let idx;
  if (input.indexName) {
    idx = indexesOf(t).find((i) => i.name === input.indexName);
    if (!idx) throw validation(`The table does not have the specified index: ${input.indexName}`);
    all = all.filter((it) => it[idx.partition.name] && (!idx.sort || it[idx.sort.name]));
  }
  const key = tableKey(t);
  all.sort((a, b) => JSON.stringify(a[key.partition.name]).localeCompare(JSON.stringify(b[key.partition.name])) || (key.sort ? compare(a[key.sort.name], b[key.sort.name]) ?? 0 : 0));
  const r = page(t, all, input, ctx, "Scan", idx);
  await consume(engine, t, "read", readUnits(r.bytes, input.consistentRead === true));
  await bump(engine, t, { scans: 1 });
  await engine.metrics.record(t.accountId, t.region, "AWS/DynamoDB", "ReturnedItemCount", { TableName: t.name, Operation: "Scan" }, r.out.length, "Count");
  return { ...input.select === "COUNT" ? {} : { Items: r.out }, Count: r.out.length, ScannedCount: r.scanned, ...r.last ? { LastEvaluatedKey: r.last } : {} };
}

// src/engine/dynamodb/partiql.ts
var malformed = (msg) => validation(`Statement wasn't well formed, can't be processed: ${msg}`);
function tokenize2(src) {
  const out = [];
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
      for (; ; ) {
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
    const num3 = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(rest);
    if (num3 && !(ch === "-" && out.length && ["num", "ident", "qident", "str"].includes(out[out.length - 1].k))) {
      out.push({ k: "num", v: num3[0] });
      i += num3[0].length;
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
var P = class {
  constructor(t, params) {
    this.t = t;
    this.params = params;
    this.i = 0;
    this.names = {};
    this.values = {};
    this.nameIds = /* @__PURE__ */ new Map();
    this.paramIndex = 0;
  }
  peek(o = 0) {
    return this.t[this.i + o];
  }
  next() {
    return this.t[this.i++];
  }
  kw(word, o = 0) {
    const x = this.peek(o);
    return x.k === "ident" && x.v.toUpperCase() === word;
  }
  is(v) {
    return this.peek().k === "punct" && this.peek().v === v;
  }
  expectKw(word) {
    if (!this.kw(word)) throw malformed(`Unexpected token: ${this.peek().v}, expected ${word}`);
    this.next();
  }
  expect(v) {
    if (!this.is(v)) throw malformed(`Unexpected token: ${this.peek().v}, expected ${v}`);
    this.next();
  }
  /** "Table" or Table, optionally ."Index". */
  tableRef() {
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
  nameRef(raw) {
    let id = this.nameIds.get(raw);
    if (!id) {
      id = `#n${this.nameIds.size}`;
      this.nameIds.set(raw, id);
      this.names[id] = raw;
    }
    return id;
  }
  valueRef(v) {
    const id = `:v${Object.keys(this.values).length}`;
    this.values[id] = v;
    return id;
  }
  /** A path such as "address"."city" or items[0] → raw names and the placeholder text. */
  path() {
    const first = this.next();
    if (first.k !== "qident" && first.k !== "ident") throw malformed(`Unexpected token: ${first.v}`);
    const raw = [first.v];
    let text = this.nameRef(first.v);
    for (; ; ) {
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
  literal() {
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
      const items = [];
      while (!this.is("]")) {
        items.push(this.literal());
        if (this.is(",")) this.next();
        else break;
      }
      this.expect("]");
      return { L: items };
    }
    if (x.k === "punct" && x.v === "{") {
      const m = {};
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
      const vals = [];
      while (!this.is(">>")) {
        vals.push(this.literal());
        if (this.is(",")) this.next();
        else break;
      }
      this.expect(">>");
      if (vals.length === 0) throw validation("One or more parameter values were invalid: An string set  may not be empty");
      if (vals.every((v) => "S" in v)) return { SS: vals.map((v) => v.S) };
      if (vals.every((v) => "N" in v)) return { NS: vals.map((v) => v.N) };
      throw validation("Sets must hold values of one type (all strings or all numbers)");
    }
    throw malformed(`Unexpected token: ${x.v}`);
  }
  isLiteralStart() {
    const x = this.peek();
    return x.k === "str" || x.k === "num" || x.k === "param" || x.k === "punct" && ["[", "{", "<<"].includes(x.v) || x.k === "ident" && ["TRUE", "FALSE", "NULL"].includes(x.v.toUpperCase());
  }
  operand() {
    if (this.isLiteralStart()) {
      const v = this.literal();
      return { text: this.valueRef(v), value: v };
    }
    const p = this.path();
    return { text: p.text, raw: p.raw };
  }
  // WHERE: returns a list of top-level AND conjuncts (each as text plus what it says about keys).
  condition() {
    const parts = [this.orExpr()];
    return parts.length === 1 && parts[0].and ? parts[0].and : parts;
  }
  orExpr() {
    let left = this.andExpr();
    while (this.kw("OR")) {
      this.next();
      const right = this.andExpr();
      left = { text: `(${left.text}) OR (${right.text})` };
    }
    return left;
  }
  andExpr() {
    const parts = [this.notExpr()];
    while (this.kw("AND")) {
      this.next();
      parts.push(this.notExpr());
    }
    if (parts.length === 1) return parts[0];
    const flat = parts.flatMap((p) => p.and ?? [p]);
    return { text: flat.map((p) => `(${p.text})`).join(" AND "), and: flat };
  }
  notExpr() {
    if (this.kw("NOT")) {
      this.next();
      const c = this.notExpr();
      return { text: `NOT (${c.text})` };
    }
    return this.primary();
  }
  primary() {
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
        const op2 = this.next();
        if (!["=", "<>", "!=", "<", "<=", ">", ">="].includes(op2.v)) throw malformed(`Unexpected token: ${op2.v}`);
        const b2 = this.operand();
        return { text: `size(${a.text}) ${op2.v === "!=" ? "<>" : op2.v} ${b2.text}` };
      }
      this.expect(",");
      const b = this.operand();
      this.expect(")");
      return { text: `${name}(${a.text}, ${b.text})`, key: name === "begins_with" ? { attr: a.raw.join("."), op: "begins_with" } : void 0 };
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
      return { text: `${left.text} BETWEEN ${lo.text} AND ${hi.text}`, key: left.raw ? { attr: left.raw.join("."), op: "BETWEEN" } : void 0 };
    }
    if (this.kw("IN")) {
      this.next();
      const close = this.is("[") ? "]" : ")";
      this.next();
      const list2 = [this.operand().text];
      while (this.is(",")) {
        this.next();
        list2.push(this.operand().text);
      }
      this.expect(close);
      return { text: `${left.text} IN (${list2.join(", ")})` };
    }
    const op = this.next();
    if (!["=", "<>", "!=", "<", "<=", ">", ">="].includes(op.v)) throw malformed(`Unexpected token: ${op.v}`);
    const right = this.operand();
    const sym = op.v === "!=" ? "<>" : op.v;
    const keyAttr = left.raw && right.value ? left.raw.join(".") : right.raw && left.value ? right.raw.join(".") : void 0;
    return { text: `${left.text} ${sym} ${right.text}`, key: keyAttr ? { attr: keyAttr, op: sym, value: left.value ?? right.value } : void 0 };
  }
  end() {
    if (this.peek().k !== "end") throw malformed(`Unexpected token: ${this.peek().v}`);
    if (this.paramIndex !== this.params.length) throw validation("Number of parameters in request and statement don't match.");
  }
};
function splitKey(conjs, key) {
  const pk = conjs.find((c) => c.key?.attr === key.partition.name && c.key.op === "=");
  if (!pk) return null;
  const sk = key.sort ? conjs.find((c) => c !== pk && c.key?.attr === key.sort.name && ["=", "<", "<=", ">", ">=", "BETWEEN", "begins_with"].includes(c.key.op)) : void 0;
  const rest = conjs.filter((c) => c !== pk && c !== sk);
  return { keyCondition: [pk, sk].filter(Boolean).map((c) => c.text).join(" AND "), filter: rest.map((c) => `(${c.text})`).join(" AND ") || void 0 };
}
function used(p, ...texts) {
  const all = texts.filter(Boolean).join(" ");
  const names = Object.fromEntries(Object.entries(p.names).filter(([k]) => new RegExp(`${k}(?![0-9])`).test(all)));
  const values = Object.fromEntries(Object.entries(p.values).filter(([k]) => new RegExp(`${k}(?![0-9])`).test(all)));
  return { names: Object.keys(names).length ? names : void 0, values: Object.keys(values).length ? values : void 0 };
}
async function findTable(engine, accountId, region, name) {
  const t = (await engine.list(accountId, { service: "dynamodb", type: "table", region })).find((x) => x.name === name);
  if (!t) throw new EngineError("ResourceNotFoundException", "Requested resource not found", 400);
  return t;
}
function fullKeyFrom(conjs, key) {
  const want = [key.partition, ...key.sort ? [key.sort] : []];
  const k = {};
  const rest = [...conjs];
  for (const w of want) {
    const c = rest.find((x) => x.key?.attr === w.name && x.key.op === "=" && x.key.value);
    if (!c) throw validation("Where clause does not contain a mandatory equality on all key attributes");
    k[w.name] = c.key.value;
    rest.splice(rest.indexOf(c), 1);
  }
  return { key: k, rest };
}
function readable(p, r) {
  if (!r.translated) return r;
  const lit = (v) => "S" in v ? `'${v.S}'` : "N" in v ? v.N : JSON.stringify(Object.values(v)[0]);
  const fill = (text) => text?.replace(/#n\d+/g, (m) => p.names[m] ?? m).replace(/:v\d+/g, (m) => p.values[m] ? lit(p.values[m]) : m).replace(/^\((.*)\)$/, "$1");
  return { ...r, translated: Object.fromEntries(Object.entries(r.translated).map(([k, v]) => [k, fill(v)])) };
}
async function executeStatement(engine, accountId, region, statement, params = []) {
  const p = new P(tokenize2(statement.trim() ? statement : "x"), params);
  return readable(p, await run(engine, accountId, region, statement, p));
}
async function run(engine, accountId, region, statement, p) {
  if (!statement.trim()) throw validation("1 validation error detected: Value '' at 'statement' failed to satisfy constraint: Member must have length greater than or equal to 1");
  if (p.kw("SELECT")) {
    p.next();
    let projection;
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
    let conjs = [];
    if (p.kw("WHERE")) {
      p.next();
      conjs = p.condition();
    }
    let desc = false;
    let orderBy;
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
    let key = tableKey(t);
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
      const all2 = used(p, split.keyCondition, split.filter, projection);
      const r = await query(engine, t, { keyCondition: split.keyCondition, filter: split.filter, projection, ...all2, indexName: ref.index, scanIndexForward: !desc });
      return { Items: r.Items, ranAs: "Query", index: ref.index, scannedCount: r.ScannedCount, translated: { keyCondition: split.keyCondition, filter: split.filter } };
    }
    const filter = conjs.length ? conjs.map((c) => `(${c.text})`).join(" AND ") : void 0;
    const all = used(p, filter, projection);
    const items = [];
    let scanned = 0;
    let start;
    for (let i = 0; i < 50; i++) {
      const r = await scan(engine, t, { filter, projection, ...all, indexName: ref.index, exclusiveStartKey: start });
      items.push(...r.Items ?? []);
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
    const sets = [];
    const removes = [];
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
    const condition = rest.length ? rest.map((c) => `(${c.text})`).join(" AND ") : void 0;
    const all = used(p, condition);
    await deleteItem(engine, t, key, { condition, ...all });
    return { ranAs: "DeleteItem", translated: condition ? { condition } : void 0 };
  }
  throw malformed(`Unexpected keyword: ${p.peek().v}. Statements start with SELECT, INSERT, UPDATE or DELETE.`);
}

// src/engine/dynamodb/api.ts
var invalid = (m) => validation(`One or more parameter values were invalid: ${m}`);
var missing = (_param, path2) => validation(`1 validation error detected: Value null at '${path2}' failed to satisfy constraint: Member must not be null`);
function str(body, param, path2 = param.charAt(0).toLowerCase() + param.slice(1)) {
  const v = body[param];
  if (typeof v !== "string" || !v) throw missing(param, path2);
  return v;
}
var unsupported = (what) => validation(`CloudLab doesn't support ${what} yet. Use expression parameters (KeyConditionExpression, FilterExpression, ConditionExpression, UpdateExpression, ProjectionExpression) instead.`);
function refuseLegacy(body) {
  for (const [p, alt] of [
    ["KeyConditions", "KeyConditionExpression"],
    ["QueryFilter", "FilterExpression"],
    ["ScanFilter", "FilterExpression"],
    ["Expected", "ConditionExpression"],
    ["AttributeUpdates", "UpdateExpression"],
    ["AttributesToGet", "ProjectionExpression"]
  ]) {
    if (body[p] !== void 0) throw unsupported(`the legacy parameter ${p} (use ${alt})`);
  }
}
async function tables(ctx) {
  return ctx.host.list(ctx.accountId, { service: "dynamodb", type: "table", region: ctx.region });
}
async function table(ctx, nameOrArn) {
  const t = (await tables(ctx)).find((x) => x.name === nameOrArn || x.id === nameOrArn);
  if (!t) throw new EngineError("ResourceNotFoundException", `Requested resource not found: Table: ${nameOrArn} not found`, 400);
  return t;
}
var expr = (body) => ({ names: body.ExpressionAttributeNames, values: body.ExpressionAttributeValues });
var epoch = (iso) => typeof iso === "string" ? Date.parse(iso) / 1e3 : iso;
function wire(t, status) {
  const d = describeTable(t, status);
  const billing = d.BillingModeSummary;
  return {
    ...d,
    CreationDateTime: epoch(d.CreationDateTime),
    ...billing ? { BillingModeSummary: { ...billing, LastUpdateToPayPerRequestDateTime: epoch(billing.LastUpdateToPayPerRequestDateTime) } } : {}
  };
}
function keyOf(schema, where) {
  const hash = (schema ?? []).filter((k) => k.KeyType === "HASH");
  const range = (schema ?? []).filter((k) => k.KeyType === "RANGE");
  if (!schema?.length || hash.length !== 1 || range.length > 1 || hash.length + range.length !== schema.length || schema[0].KeyType !== "HASH") {
    throw invalid(`Invalid KeySchema${where}: The first KeySchemaElement is not a HASH key type`);
  }
  return { pk: hash[0].AttributeName ?? "", sk: range[0]?.AttributeName };
}
function createTableConfig(body) {
  const name = str(body, "TableName");
  const defs = body.AttributeDefinitions ?? [];
  if (!defs.length) throw missing("AttributeDefinitions", "attributeDefinitions");
  if (!body.KeySchema) throw missing("KeySchema", "keySchema");
  const types = /* @__PURE__ */ new Map();
  defs.forEach((d, i) => {
    if (!["S", "N", "B"].includes(String(d.AttributeType))) {
      throw validation(`1 validation error detected: Value '${d.AttributeType}' at 'attributeDefinitions.${i + 1}.member.attributeType' failed to satisfy constraint: Member must satisfy enum value set: [B, N, S]`);
    }
    types.set(String(d.AttributeName), String(d.AttributeType));
  });
  if (body.LocalSecondaryIndexes !== void 0) throw validation("CloudLab doesn't support local secondary indexes yet. Use a global secondary index.");
  const { pk, sk } = keyOf(body.KeySchema, "");
  const gsis = body.GlobalSecondaryIndexes ?? [];
  const gsiKeys = gsis.map((g) => {
    if (!g.IndexName) throw missing("IndexName", "globalSecondaryIndexes.1.member.indexName");
    if (g.Projection?.ProjectionType && g.Projection.ProjectionType !== "ALL") throw validation("CloudLab's global secondary indexes project ALL attributes. Use Projection: { ProjectionType: 'ALL' }.");
    return { name: g.IndexName, ...keyOf(g.KeySchema, ` for index ${g.IndexName}`) };
  });
  const used2 = /* @__PURE__ */ new Set([pk, ...sk ? [sk] : [], ...gsiKeys.flatMap((g) => [g.pk, ...g.sk ? [g.sk] : []])]);
  for (const k of used2) {
    if (!types.has(k)) throw invalid(`Some index key attributes are not defined in AttributeDefinitions. Keys: [${k}], AttributeDefinitions: [${[...types.keys()].join(", ")}]`);
  }
  if (used2.size !== types.size) throw invalid("Number of attributes in KeySchema does not exactly match number of attributes defined in AttributeDefinitions");
  const billing = String(body.BillingMode ?? "PROVISIONED");
  if (!["PROVISIONED", "PAY_PER_REQUEST"].includes(billing)) {
    throw validation(`1 validation error detected: Value '${billing}' at 'billingMode' failed to satisfy constraint: Member must satisfy enum value set: [PROVISIONED, PAY_PER_REQUEST]`);
  }
  const tp = body.ProvisionedThroughput;
  if (billing === "PROVISIONED" && (!tp?.ReadCapacityUnits || !tp?.WriteCapacityUnits)) throw invalid("ReadCapacityUnits and WriteCapacityUnits must both be specified when BillingMode is PROVISIONED");
  if (billing === "PAY_PER_REQUEST" && tp) throw invalid("Neither ReadCapacityUnits nor WriteCapacityUnits can be specified when BillingMode is PAY_PER_REQUEST");
  return {
    name,
    partitionKey: pk,
    partitionKeyType: types.get(pk),
    ...sk ? { sortKey: sk, sortKeyType: types.get(sk) } : {},
    billingMode: billing,
    ...billing === "PROVISIONED" ? { readCapacity: Number(tp.ReadCapacityUnits), writeCapacity: Number(tp.WriteCapacityUnits) } : {},
    globalSecondaryIndexes: gsiKeys.map((g) => ({
      indexName: g.name,
      partitionKey: g.pk,
      partitionKeyType: types.get(g.pk),
      ...g.sk ? { sortKey: g.sk, sortKeyType: types.get(g.sk) } : {}
    })),
    deletionProtection: body.DeletionProtectionEnabled === true
  };
}
async function updateTableInput(ctx, body) {
  const t = await table(ctx, str(body, "TableName"));
  const patch = {};
  if (body.BillingMode !== void 0) patch.billingMode = body.BillingMode;
  const tp = body.ProvisionedThroughput;
  if (tp) {
    if ((patch.billingMode ?? t.config.billingMode) === "PAY_PER_REQUEST") throw invalid("Neither ReadCapacityUnits nor WriteCapacityUnits can be specified when BillingMode is PAY_PER_REQUEST");
    patch.readCapacity = Number(tp.ReadCapacityUnits);
    patch.writeCapacity = Number(tp.WriteCapacityUnits);
  } else if (patch.billingMode === "PROVISIONED" && t.config.billingMode !== "PROVISIONED") {
    throw invalid("ProvisionedThroughput must be specified when BillingMode is PROVISIONED");
  }
  if (body.DeletionProtectionEnabled !== void 0) patch.deletionProtection = body.DeletionProtectionEnabled === true;
  const updates = body.GlobalSecondaryIndexUpdates ?? [];
  if (updates.length) {
    const defs = new Map((body.AttributeDefinitions ?? []).map((d) => [d.AttributeName, d.AttributeType]));
    let gsis = [...t.config.globalSecondaryIndexes ?? []];
    for (const u of updates) {
      if (u.Create) {
        const g = u.Create;
        if (!g.IndexName) throw missing("IndexName", "globalSecondaryIndexUpdates.1.member.create.indexName");
        if (gsis.some((x) => x.indexName === g.IndexName)) throw invalid(`Attempting to create an index which already exists: ${g.IndexName}`);
        const { pk, sk } = keyOf(g.KeySchema, ` for index ${g.IndexName}`);
        const typeOf2 = (k) => {
          const v = defs.get(k);
          if (!v) throw invalid(`Some index key attributes are not defined in AttributeDefinitions. Keys: [${k}], AttributeDefinitions: [${[...defs.keys()].join(", ")}]`);
          return v;
        };
        gsis.push({ indexName: g.IndexName, partitionKey: pk, partitionKeyType: typeOf2(pk), ...sk ? { sortKey: sk, sortKeyType: typeOf2(sk) } : {} });
      } else if (u.Delete) {
        if (!gsis.some((x) => x.indexName === u.Delete.IndexName)) throw new EngineError("ResourceNotFoundException", `Requested resource not found: Index: ${u.Delete.IndexName} not found`, 400);
        gsis = gsis.filter((x) => x.indexName !== u.Delete.IndexName);
      } else if (u.Update) {
      }
    }
    patch.globalSecondaryIndexes = gsis;
  }
  if (body.StreamSpecification !== void 0) throw validation("CloudLab doesn't support DynamoDB Streams yet.");
  if (!Object.keys(patch).length) throw validation("At least one of ProvisionedThroughput, BillingMode, UpdateStreamEnabled, GlobalSecondaryIndexUpdates or SSESpecification or ReplicaUpdates is required");
  return { t, patch };
}
var MAX_BATCH_WRITE = 25;
var MAX_BATCH_GET = 100;
var MAX_TRANSACT = 100;
var ops = {
  async CreateTable(ctx, body) {
    if (body.StreamSpecification && body.StreamSpecification.StreamEnabled) throw validation("CloudLab doesn't support DynamoDB Streams yet.");
    const t = await ctx.createTable(createTableConfig(body));
    return { TableDescription: wire(t, "CREATING") };
  },
  async DescribeTable(ctx, body) {
    return { Table: wire(await table(ctx, str(body, "TableName"))) };
  },
  async ListTables(ctx, body) {
    const names = (await tables(ctx)).map((t) => t.name).sort();
    const after = body.ExclusiveStartTableName ? String(body.ExclusiveStartTableName) : null;
    const limit = body.Limit === void 0 ? 100 : Number(body.Limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw validation(`1 validation error detected: Value '${body.Limit}' at 'limit' failed to satisfy constraint: Member must have value less than or equal to 100`);
    const rest = after ? names.filter((n) => n > after) : names;
    const page3 = rest.slice(0, limit);
    return { TableNames: page3, ...rest.length > limit ? { LastEvaluatedTableName: page3[page3.length - 1] } : {} };
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
    const spec = body.TimeToLiveSpecification;
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
    return putItem(ctx.host, t, body.Item, { ...expr(body), condition: body.ConditionExpression, returnValues: body.ReturnValues });
  },
  async GetItem(ctx, body) {
    refuseLegacy(body);
    const t = await table(ctx, str(body, "TableName"));
    if (body.Key === void 0) throw missing("Key", "key");
    return getItem(ctx.host, t, body.Key, { ...expr(body), projection: body.ProjectionExpression, consistentRead: body.ConsistentRead === true });
  },
  async UpdateItem(ctx, body) {
    refuseLegacy(body);
    const t = await table(ctx, str(body, "TableName"));
    if (body.Key === void 0) throw missing("Key", "key");
    if (!body.UpdateExpression) throw validation("CloudLab needs an UpdateExpression for UpdateItem (for example SET #n = :v).");
    return updateItem(ctx.host, t, body.Key, {
      ...expr(body),
      update: String(body.UpdateExpression),
      condition: body.ConditionExpression,
      returnValues: body.ReturnValues
    });
  },
  async DeleteItem(ctx, body) {
    refuseLegacy(body);
    const t = await table(ctx, str(body, "TableName"));
    if (body.Key === void 0) throw missing("Key", "key");
    return deleteItem(ctx.host, t, body.Key, { ...expr(body), condition: body.ConditionExpression, returnValues: body.ReturnValues });
  },
  async Query(ctx, body) {
    refuseLegacy(body);
    const t = await table(ctx, str(body, "TableName"));
    return query(ctx.host, t, {
      ...expr(body),
      keyCondition: String(body.KeyConditionExpression ?? ""),
      filter: body.FilterExpression,
      projection: body.ProjectionExpression,
      indexName: body.IndexName,
      scanIndexForward: body.ScanIndexForward !== false,
      limit: body.Limit,
      exclusiveStartKey: body.ExclusiveStartKey,
      select: body.Select,
      consistentRead: body.ConsistentRead === true
    });
  },
  async Scan(ctx, body) {
    refuseLegacy(body);
    const t = await table(ctx, str(body, "TableName"));
    const total = body.TotalSegments;
    const segment = body.Segment;
    if (total === void 0 !== (segment === void 0)) throw validation("The TotalSegments parameter is required but was not present in the request when Segment parameter is present");
    if (total !== void 0 && segment > 0) return { Items: [], Count: 0, ScannedCount: 0 };
    return scan(ctx.host, t, {
      ...expr(body),
      filter: body.FilterExpression,
      projection: body.ProjectionExpression,
      indexName: body.IndexName,
      limit: body.Limit,
      exclusiveStartKey: body.ExclusiveStartKey,
      select: body.Select,
      consistentRead: body.ConsistentRead === true
    });
  },
  async BatchWriteItem(ctx, body) {
    const req = body.RequestItems ?? {};
    const all = Object.values(req).flat();
    if (!all.length) throw validation("1 validation error detected: Value '{}' at 'requestItems' failed to satisfy constraint: Member must have length greater than or equal to 1");
    if (all.length > MAX_BATCH_WRITE) throw validation(`1 validation error detected: Value at 'requestItems' failed to satisfy constraint: Map value must satisfy constraint: [Member must have length less than or equal to ${MAX_BATCH_WRITE}, Member must have length greater than or equal to 1]`);
    for (const [name, writes] of Object.entries(req)) {
      const t = await table(ctx, name);
      const seen = /* @__PURE__ */ new Set();
      const key = tableKey(t);
      for (const w of writes) {
        const it = w.PutRequest?.Item ?? w.DeleteRequest?.Key;
        if (!it || w.PutRequest && w.DeleteRequest) throw validation("Supplied AttributeValue has more than one datatypes set, must contain exactly one of the supported datatypes");
        const id = JSON.stringify([it[key.partition.name], key.sort ? it[key.sort.name] : null]);
        if (seen.has(id)) throw validation("Provided list of item keys contains duplicates");
        seen.add(id);
      }
      for (const w of writes) {
        if (w.PutRequest) await putItem(ctx.host, t, w.PutRequest.Item);
        else await deleteItem(ctx.host, t, w.DeleteRequest.Key);
      }
    }
    return { UnprocessedItems: {} };
  },
  async BatchGetItem(ctx, body) {
    const req = body.RequestItems ?? {};
    const count = Object.values(req).reduce((n, r) => n + (r.Keys?.length ?? 0), 0);
    if (!count) throw validation("1 validation error detected: Value '{}' at 'requestItems' failed to satisfy constraint: Member must have length greater than or equal to 1");
    if (count > MAX_BATCH_GET) throw validation("Too many items requested for the BatchGetItem call");
    const responses = {};
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
    const list2 = body.TransactItems ?? [];
    if (!list2.length || list2.length > MAX_TRANSACT) throw validation(`1 validation error detected: Value at 'transactItems' failed to satisfy constraint: Member must have length less than or equal to ${MAX_TRANSACT}`);
    const steps = await Promise.all(
      list2.map(async (x) => {
        const kind = ["Put", "Update", "Delete", "ConditionCheck"].find((k) => x[k]);
        if (!kind) throw validation("TransactItems can only contain one of Check, Put, Update or Delete");
        const op = x[kind];
        return { kind, op, t: await table(ctx, op.TableName) };
      })
    );
    const seen = /* @__PURE__ */ new Set();
    for (const s of steps) {
      const key = tableKey(s.t);
      const it = s.op.Key ?? s.op.Item ?? {};
      const id = `${s.t.id}|${JSON.stringify([it[key.partition.name], key.sort ? it[key.sort.name] : null])}`;
      if (seen.has(id)) throw validation("Transaction request cannot include multiple operations on one item");
      seen.add(id);
    }
    const before = /* @__PURE__ */ new Map();
    for (const s of steps) {
      if (before.has(s.t.id)) continue;
      const t = await ctx.host.get(s.t.accountId, s.t.id);
      before.set(s.t.id, { ...t, attributes: { ...t.attributes, items: { ...t.attributes.items ?? {} }, stats: { ...t.attributes.stats ?? {} } } });
    }
    const reasons = steps.map(() => ({ Code: "None" }));
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
        400
      );
      e.extra = { CancellationReasons: reasons };
      throw e;
    }
    return {};
  },
  async TransactGetItems(ctx, body) {
    const list2 = body.TransactItems ?? [];
    if (!list2.length || list2.length > MAX_TRANSACT) throw validation(`1 validation error detected: Value at 'transactItems' failed to satisfy constraint: Member must have length less than or equal to ${MAX_TRANSACT}`);
    const out = [];
    for (const x of list2) {
      if (!x.Get) throw validation("TransactItems can only contain Get");
      const t = await table(ctx, x.Get.TableName);
      const r = await getItem(ctx.host, t, x.Get.Key, { names: x.Get.ExpressionAttributeNames, projection: x.Get.ProjectionExpression, consistentRead: true });
      out.push(r.Item ? { Item: r.Item } : {});
    }
    return { Responses: out };
  },
  async ExecuteStatement(ctx, body) {
    const r = await executeStatement(ctx.host, ctx.accountId, ctx.region, str(body, "Statement"), body.Parameters ?? []);
    return { Items: r.Items ?? [] };
  },
  async BatchExecuteStatement(ctx, body) {
    const list2 = body.Statements ?? [];
    if (!list2.length || list2.length > 25) throw validation("1 validation error detected: Value at 'statements' failed to satisfy constraint: Member must have length less than or equal to 25");
    const out = [];
    for (const s of list2) {
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
    return { AccountMaxReadCapacityUnits: 8e4, AccountMaxWriteCapacityUnits: 8e4, TableMaxReadCapacityUnits: 4e4, TableMaxWriteCapacityUnits: 4e4 };
  },
  async DescribeEndpoints() {
    return { Endpoints: [] };
  },
  async ListTagsOfResource() {
    return { Tags: [] };
  }
};
async function restore(host, before) {
  for (const t of before.values()) {
    const { items, itemCount, tableSizeBytes, stats } = t.attributes;
    await host.setAttributes(t.accountId, t.id, { items, itemCount, tableSizeBytes, stats });
  }
}
var DYNAMODB_OPERATIONS = Object.keys(ops);
async function dynamodbApi(operation, body, ctx) {
  const handler = ops[operation];
  if (!handler) throw new EngineError("UnknownOperationException", operation ? `CloudLab's DynamoDB doesn't support ${operation} yet.` : "", 400);
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  return handler(ctx, b);
}

// src/engine/dynamodb/explore.ts
async function explore(host, t, input) {
  const plain = (items) => (items ?? []).map(unmarshallItem);
  switch (input.action) {
    case "scan": {
      const r = await scan(host, t, { indexName: input.indexName, limit: input.limit });
      return { items: plain(r.Items), count: r.Count, scannedCount: r.ScannedCount, more: !!r.LastEvaluatedKey };
    }
    case "query": {
      const idx = input.indexName ? (t.config.globalSecondaryIndexes ?? []).find((g) => g.indexName === input.indexName) : null;
      const pk = String(idx ? idx.partitionKey : t.config.partitionKey);
      const pkType = String(idx ? idx.partitionKeyType : t.config.partitionKeyType);
      const sk = idx ? idx.sortKey : t.config.sortKey;
      const skType = String(idx ? idx.sortKeyType ?? "S" : t.config.sortKeyType ?? "S");
      const typed = (v, type) => type === "N" ? { N: String(v) } : type === "B" ? { B: String(v) } : { S: String(v) };
      const names = { "#pk": pk };
      const values = { ":pk": typed(input.partitionValue, pkType) };
      let expr2 = "#pk = :pk";
      if (input.sort && sk) {
        names["#sk"] = sk;
        values[":sk"] = typed(input.sort.value, skType);
        if (input.sort.op === "begins_with") expr2 += " AND begins_with(#sk, :sk)";
        else if (input.sort.op === "between") {
          values[":sk2"] = typed(input.sort.value2 ?? input.sort.value, skType);
          expr2 += " AND #sk BETWEEN :sk AND :sk2";
        } else expr2 += ` AND #sk ${input.sort.op} :sk`;
      }
      const r = await query(host, t, { keyCondition: expr2, names, values, indexName: input.indexName, scanIndexForward: input.forward, limit: input.limit });
      return { items: plain(r.Items), count: r.Count, scannedCount: r.ScannedCount, more: !!r.LastEvaluatedKey, expression: expr2 };
    }
    case "put": {
      const item = marshallItem(input.item);
      await putItem(host, t, item, input.mustBeNew ? { condition: "attribute_not_exists(#pk)", names: { "#pk": String(t.config.partitionKey) } } : {});
      return { saved: true };
    }
    case "statement": {
      const r = await executeStatement(host, t.accountId, t.region, input.statement);
      return { items: r.Items ? plain(r.Items) : void 0, ranAs: r.ranAs, index: r.index, scannedCount: r.scannedCount, translated: r.translated };
    }
    case "delete": {
      await deleteItem(host, t, marshallItem(input.key));
      return { deleted: true };
    }
  }
}

// src/local/file-host.ts
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
var FLUSH_MS = 200;
var FILE = /^[a-zA-Z0-9_.~-]{1,255}\.json$/;
var SAFE = /^[a-zA-Z0-9_.-]{1,200}$/;
var fileName = (name) => SAFE.test(name) && !name.startsWith(".") ? name : `~${Buffer.from(name).toString("base64url")}`;
var FileResourceHost = class {
  constructor(dir, service, type, notFound3, onChange = () => void 0, now = () => /* @__PURE__ */ new Date()) {
    this.dir = dir;
    this.service = service;
    this.type = type;
    this.notFound = notFound3;
    this.onChange = onChange;
    this.now = now;
    this.holdsLocalItems = true;
    this.metrics = { record: async () => void 0 };
    this.resources = /* @__PURE__ */ new Map();
    this.byId = /* @__PURE__ */ new Map();
    this.dirty = /* @__PURE__ */ new Set();
    this.timer = null;
    this.calls = /* @__PURE__ */ new Map();
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!FILE.test(f)) continue;
      try {
        const r = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
        if (r?.name && r.config) this.index(r);
      } catch {
      }
    }
  }
  index(r) {
    const old = this.resources.get(r.name);
    if (old) this.byId.delete(old.id);
    this.resources.set(r.name, r);
    this.byId.set(r.id, r);
  }
  file(name) {
    return path.join(this.dir, `${fileName(name)}.json`);
  }
  write(name) {
    const r = this.resources.get(name);
    if (!r) return;
    const tmp = `${this.file(name)}.tmp`;
    writeFileSync(tmp, JSON.stringify(r));
    renameSync(tmp, this.file(name));
  }
  markDirty(name) {
    this.dirty.add(name);
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }
  /** Writes every pending change to disk now. */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const name of this.dirty) this.write(name);
    this.dirty.clear();
  }
  /**
   * A copy of a resource for a caller that may change it. Services override this to
   * copy only what their code changes (DynamoDB replaces items but never edits one;
   * SQS edits its messages), which is much faster than copying everything.
   */
  copy(r) {
    return structuredClone(r);
  }
  /** The data a new resource of this kind starts with (no items, no messages…). */
  initialAttributes() {
    return {};
  }
  /** Attributes that always follow the spec (an ARN, a URL), even for a resource that already exists. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  specAttributes(spec) {
    return {};
  }
  /** Creates the resource, or brings its settings up to date. Its data is kept. */
  upsert(spec) {
    const old = this.resources.get(spec.name);
    const now = this.now().toISOString();
    const r = {
      id: spec.id,
      accountId: "local",
      region: LOCAL_REGION,
      service: this.service,
      type: this.type,
      name: spec.name,
      state: spec.state ?? old?.state ?? "ACTIVE",
      pendingState: null,
      transitionAt: null,
      config: { ...spec.config, name: spec.name },
      attributes: { ...this.initialAttributes(), ...old ? old.attributes : spec.attributes ?? {}, ...this.specAttributes(spec) },
      refs: [],
      createdAt: old?.createdAt ?? spec.createdAt ?? now,
      updatedAt: now
    };
    this.index(r);
    this.write(r.name);
    return this.copy(r);
  }
  remove(name) {
    const r = this.resources.get(name);
    if (r) this.byId.delete(r.id);
    this.resources.delete(name);
    this.dirty.delete(name);
    rmSync(this.file(name), { force: true });
  }
  has(name) {
    return this.resources.has(name);
  }
  /** Whether a resource (by ID or name) is in this store. */
  owns(id) {
    return this.byId.has(id) || this.resources.has(id);
  }
  names() {
    return [...this.resources.keys()];
  }
  /** A copy of the resource, by name. */
  byName(name) {
    const r = this.resources.get(name);
    if (!r) throw this.notFound(name);
    return this.copy(r);
  }
  /** The live resource, for reading counts without copying (don't change it). */
  peek(name) {
    return this.resources.get(name);
  }
  /** Where a resource's file is (shown in the console). */
  pathOf(name) {
    return this.file(name);
  }
  // ---------- ServiceHost ----------
  async get(_accountId, id) {
    const r = this.byId.get(id) ?? this.resources.get(id);
    if (!r) throw this.notFound(id.split(/[/:]/).pop() ?? id);
    return this.copy(r);
  }
  async list(_accountId, filter) {
    if (filter.service && filter.service !== this.service || filter.type && filter.type !== this.type) return [];
    if (filter.region && filter.region !== LOCAL_REGION) return [];
    return [...this.resources.values()].map((r) => this.copy(r));
  }
  async setAttributes(_accountId, id, patch) {
    const r = this.byId.get(id);
    if (!r) return;
    r.attributes = { ...r.attributes, ...patch };
    r.updatedAt = this.now().toISOString();
    this.markDirty(r.name);
    this.onChange(r);
  }
  async countInWindow(key, windowMs) {
    const now = this.now().getTime();
    const recent = (this.calls.get(key) ?? []).filter((at) => at > now - windowMs);
    recent.push(now);
    this.calls.set(key, recent);
    return recent.length;
  }
};

// src/local/dynamodb-host.ts
var FileTableHost = class extends FileResourceHost {
  constructor(dir, onChange = () => void 0, now = () => /* @__PURE__ */ new Date()) {
    super(dir, "dynamodb", "table", tableNotFound, onChange, now);
  }
  initialAttributes() {
    return { items: {}, itemCount: 0, tableSizeBytes: 0 };
  }
  /**
   * Hands out the live item map instead of a copy: copying a 2,000-item map on every
   * call made each write slower as the table grew. That's safe because items are
   * never edited in place (UpdateItem builds a new item), and every write checks
   * its limits before it changes the map (items.ts `write`); transactions keep
   * their own snapshot to roll back to.
   */
  copy(t) {
    return { ...t, config: structuredClone(t.config), refs: [...t.refs], attributes: { ...t.attributes, stats: { ...t.attributes.stats } } };
  }
  specAttributes(spec) {
    return { arn: spec.id };
  }
  report(name) {
    const t = this.peek(name);
    if (!t) return null;
    const a = t.attributes;
    return { itemCount: Number(a.itemCount ?? 0), tableSizeBytes: Number(a.tableSizeBytes ?? 0), stats: a.stats ?? {}, ...a.throttledAt ? { throttledAt: a.throttledAt } : {} };
  }
};

// src/engine/services/sqs.ts
var queueUrl = (region, accountId, name) => `https://sqs.${region}.amazonaws.com/${accountNumber(accountId)}/${name}`;
var queueArn = (region, accountId, name) => `arn:aws:sqs:${region}:${accountNumber(accountId)}:${name}`;
var urlFromArn = (arn) => {
  const [, , , region, account, name] = arn.split(":");
  return `https://sqs.${region}.amazonaws.com/${account}/${name}`;
};
var QUEUE_URL = /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]{1,80}$/;
var QUEUE_ARN = /^arn:aws:sqs:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,80}$/;
var NON_EXISTENT = () => new EngineError("AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.", 400);
var QUEUE_SETTINGS = {
  visibilityTimeout: { attr: "VisibilityTimeout", min: 0, max: 43200, default: 30 },
  messageRetentionPeriod: { attr: "MessageRetentionPeriod", min: 60, max: 1209600, default: 345600 },
  delaySeconds: { attr: "DelaySeconds", min: 0, max: 900, default: 0 },
  receiveMessageWaitTimeSeconds: { attr: "ReceiveMessageWaitTimeSeconds", min: 0, max: 20, default: 0 },
  maximumMessageSize: { attr: "MaximumMessageSize", min: 1024, max: 262144, default: 262144 }
};
var setting = (key, label, description) => {
  const s = QUEUE_SETTINGS[key];
  return { key, label, type: "number", required: true, default: s.default, min: s.min, max: s.max, param: s.attr, description };
};
var queue = {
  service: "sqs",
  type: "queue",
  label: "Queue",
  pluralLabel: "Queues",
  description: "A waiting line for messages. Producers send to it, consumers receive and delete when done. If the consumer is slow or crashes, the messages wait safely instead of being lost.",
  idPrefix: "queue",
  makeId: ({ name, region, accountId }) => queueUrl(region, accountId, name),
  idPattern: QUEUE_URL,
  notFoundCode: "AWS.SimpleQueueService.NonExistentQueue",
  notFoundMessage: () => "The specified queue does not exist.",
  notFoundByNameMessage: () => "The specified queue does not exist.",
  malformedCode: "AWS.SimpleQueueService.NonExistentQueue",
  malformedMessage: () => "The specified queue does not exist.",
  apiNoun: "queue",
  privateAttributes: ["messages"],
  panelAttributes: ["lastPurgeAt", "stats"],
  fields: [
    {
      key: "name",
      label: "Name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 80,
      pattern: "^[A-Za-z0-9_-]+$",
      patternMessage: "Up to 80 letters, numbers, hyphens and underscores.",
      placeholder: "orders-queue",
      param: "QueueName",
      description: "Becomes part of the queue's URL, which is how you send to and receive from it."
    },
    setting("visibilityTimeout", "Visibility timeout (seconds)", "After a consumer receives a message, it's hidden from others this long. Delete it in time, or it comes back to be tried again. Set it longer than processing takes."),
    setting("messageRetentionPeriod", "Message retention period (seconds)", "Messages nobody deletes are dropped after this long: 60 seconds to 14 days (1,209,600). Default 4 days (345,600)."),
    setting("delaySeconds", "Delivery delay (seconds)", "New messages stay invisible this long before anyone can receive them (0 to 900)."),
    setting("receiveMessageWaitTimeSeconds", "Receive message wait time (seconds)", "Long polling: a receive waits up to this long for a message instead of returning empty straight away (0 to 20)."),
    setting("maximumMessageSize", "Maximum message size (bytes)", "From 1,024 to 262,144 (256 KB)."),
    {
      key: "deadLetterQueue",
      label: "Dead-letter queue",
      type: "ref",
      ref: { service: "sqs", type: "queue", weak: true },
      param: "RedrivePolicy",
      description: "Optional. A message received too many times without being deleted (a 'poison' message that keeps failing) is moved here, so it stops blocking the others."
    },
    {
      key: "maxReceiveCount",
      label: "Maximum receives",
      type: "number",
      min: 1,
      max: 1e3,
      default: 10,
      param: "RedrivePolicy",
      description: "How many times a message may be received before it's moved to the dead-letter queue."
    },
    {
      key: "policy",
      label: "Access policy",
      type: "json",
      param: "Policy",
      description: "Optional. Who else may use the queue, e.g. letting an SNS topic send to it. Your own account's users and roles don't need it: their IAM policies are enough."
    }
  ],
  columns: [
    { label: "Visibility timeout", path: "config.visibilityTimeout" },
    { label: "Dead-letter queue", path: "attributes.deadLetterName" }
  ],
  iam: {
    create: "sqs:CreateQueue",
    read: "sqs:GetQueueAttributes",
    update: "sqs:SetQueueAttributes",
    delete: "sqs:DeleteQueue",
    arn: (r, account) => `arn:aws:sqs:${r.region}:${account}:${r.name}`
  },
  invalidValue({ field, value }) {
    if (field.key === "name") {
      if (typeof value === "string" && value.endsWith(".fifo")) {
        return new EngineError("InvalidParameterValue", "CloudLab simulates standard queues; FIFO queues (ending in .fifo) aren't available yet.");
      }
      return new EngineError("InvalidParameterValue", "Can only include alphanumeric characters, hyphens, or underscores. 1 to 80 in length");
    }
    const s = QUEUE_SETTINGS[field.key];
    if (s) return new EngineError("InvalidAttributeValue", `Invalid value for the parameter ${s.attr}.`);
    if (field.key === "maxReceiveCount") return new EngineError("InvalidParameterValue", 'Value {"maxReceiveCount":"' + String(value) + '"} for parameter RedrivePolicy is invalid. Reason: Invalid value for maxReceiveCount: ' + String(value) + ", valid values are from 1 to 1000 both inclusive.");
    if (field.key === "policy") return new EngineError("InvalidAttributeValue", "Invalid value for the parameter Policy.");
    return void 0;
  },
  async validate({ config, existing, ctx }) {
    if (!existing && (await ctx.list("sqs", "queue")).some((q) => q.name === config.name)) {
      throw new EngineError("QueueAlreadyExists", "A queue already exists with the same name and a different value for an attribute.", 400);
    }
    if (config.deadLetterQueue && existing && config.deadLetterQueue === existing.id) {
      throw new EngineError("InvalidParameterValue", "Value for parameter RedrivePolicy is invalid. Reason: A queue can't be its own dead-letter queue.");
    }
    if (config.policy) {
      let doc;
      try {
        doc = JSON.parse(String(config.policy));
      } catch {
        throw new EngineError("InvalidAttributeValue", "Invalid value for the parameter Policy.");
      }
      const st = doc?.Statement;
      if (!doc || typeof doc !== "object" || !(Array.isArray(st) || st && typeof st === "object")) {
        throw new EngineError("InvalidAttributeValue", "Invalid value for the parameter Policy. Reason: the policy must have a Statement.");
      }
    }
  },
  async derive({ id, config, existing, ctx }) {
    const name = String(config.name);
    const dlq = config.deadLetterQueue ? String(config.deadLetterQueue) : null;
    return {
      ...existing?.attributes ?? {},
      arn: queueArn(ctx.region, ctx.accountId, name),
      queueUrl: id,
      deadLetterName: dlq ? dlq.split("/").pop() : null,
      messages: existing?.attributes.messages ?? []
    };
  }
};

// src/engine/sqs/queue.ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
var MAX_MESSAGES = 1e3;
var MAX_QUEUE_BYTES = 4 * 1024 * 1024;
var PURGE_COOLDOWN_MS = 6e4;
var md5 = (s) => createHash("md5").update(s).digest("hex");
function md5OfAttributes(attrs) {
  const parts = [];
  const lenPrefixed = (b) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    parts.push(len, b);
  };
  for (const name of Object.keys(attrs).sort()) {
    const a = attrs[name];
    lenPrefixed(Buffer.from(name));
    lenPrefixed(Buffer.from(a.DataType));
    parts.push(Buffer.from([1]));
    lenPrefixed(Buffer.from(a.StringValue ?? ""));
  }
  return createHash("md5").update(Buffer.concat(parts)).digest("hex");
}
var messagesOf = (q) => q.attributes.messages ?? [];
var num2 = (q, key) => Number(q.config[key]);
var arnOf = (q) => String(q.attributes.arn);
function retained(q, msgs, now) {
  const keepMs = num2(q, "messageRetentionPeriod") * 1e3;
  return msgs.filter((m) => now - m.sentAt < keepMs);
}
function countsOf(q, now) {
  const msgs = retained(q, messagesOf(q), now);
  const delayed = msgs.filter((m) => m.receiveCount === 0 && m.visibleAt > now).length;
  const inFlight = msgs.filter((m) => m.receiveCount > 0 && m.visibleAt > now).length;
  const oldest = msgs.reduce((min, m) => Math.min(min, m.sentAt), now);
  return { available: msgs.length - delayed - inFlight, inFlight, delayed, oldestAgeSeconds: Math.floor((now - oldest) / 1e3) };
}
var statsOf2 = (q) => ({ sent: 0, received: 0, deleted: 0, redelivered: 0, movedToDlq: 0, fromSns: 0, ...q.attributes.stats ?? {} });
async function load2(engine, q) {
  if (q.region === LOCAL_REGION && !engine.holdsLocalItems) {
    throw new EngineError(
      "LocalQueue",
      `The messages of ${q.name} are on your computer (My computer (local)), not on CloudLab's servers. Use the console on that computer, or an AWS SDK or the AWS CLI with the endpoint http://localhost:4566.`,
      400
    );
  }
  return engine.get(q.accountId, q.id);
}
async function save2(engine, q, msgs, extra = {}, add = {}) {
  const stats = statsOf2(q);
  for (const [k, v] of Object.entries(add)) stats[k] += v ?? 0;
  await engine.setAttributes(q.accountId, q.id, { messages: msgs, stats, ...extra });
}
var SNS_SENDER = "AIDAIT2UOQQY3AUEKVGXU";
function checkAttributes(attrs) {
  if (Object.keys(attrs).length > 10) throw new EngineError("InvalidParameterValue", "Number of message attributes [" + Object.keys(attrs).length + "] exceeds the allowed maximum [10].");
  for (const [name, a] of Object.entries(attrs)) {
    if (!a?.DataType) throw new EngineError("InvalidParameterValue", `The message attribute '${name}' must contain non-empty message attribute type.`);
    if (!/^(String|Number|Binary)(\..+)?$/.test(a.DataType)) throw new EngineError("InvalidParameterValue", `The type of message (user) attribute '${name}' is invalid. You must use only the following supported type prefixes: Binary, Number, String.`);
    if (a.StringValue === void 0 || a.StringValue === "") throw new EngineError("InvalidParameterValue", `The message attribute '${name}' must contain non-empty message attribute value for message attribute type '${a.DataType}'.`);
    if (a.DataType.startsWith("Number") && Number.isNaN(Number(a.StringValue))) throw new EngineError("InvalidParameterValue", `Could not cast message attribute '${name}' value to number.`);
  }
}
async function sendMessage(engine, q, input) {
  if (input.body === void 0 || input.body === null || input.body === "") {
    throw new EngineError("MissingParameter", "The request must contain the parameter MessageBody.");
  }
  if (/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/u.test(input.body)) {
    throw new EngineError("InvalidMessageContents", "Invalid characters found. Valid unicode characters are #x9 | #xA | #xD | #x20 to #xD7FF | #xE000 to #xFFFD | #x10000 to #x10FFFF");
  }
  const attrs = input.attributes ?? {};
  checkAttributes(attrs);
  const size = Buffer.byteLength(input.body) + Object.entries(attrs).reduce((n, [k, a]) => n + k.length + a.DataType.length + (a.StringValue?.length ?? 0), 0);
  const max = num2(q, "maximumMessageSize");
  if (size > max) throw new EngineError("InvalidParameterValue", `One or more parameters are invalid. Reason: Message must be shorter than ${max} bytes.`);
  const delay = input.delaySeconds ?? num2(q, "delaySeconds");
  if (!Number.isInteger(delay) || delay < 0 || delay > 900) throw new EngineError("InvalidParameterValue", `Value ${delay} for parameter DelaySeconds is invalid. Reason: DelaySeconds must be >= 0 and <= 900.`);
  const now = engine.now().getTime();
  const fresh = await load2(engine, q);
  const msgs = retained(fresh, messagesOf(fresh), now);
  if (msgs.length >= MAX_MESSAGES) throw new EngineError("OverLimit", `CloudLab keeps at most ${MAX_MESSAGES} messages in a queue. Receive and delete some, or purge the queue.`, 403);
  if (msgs.reduce((n, m2) => n + m2.body.length, 0) + size > MAX_QUEUE_BYTES) throw new EngineError("OverLimit", "CloudLab keeps at most 4 MB of messages in a queue. Receive and delete some, or purge the queue.", 403);
  const m = {
    messageId: randomUUID(),
    body: input.body,
    md5: md5(input.body),
    attributes: attrs,
    sentAt: now,
    visibleAt: now + delay * 1e3,
    receiveCount: 0,
    senderId: input.senderId ?? accountNumber(q.accountId),
    deadLetterSourceArn: input.deadLetterSourceArn
  };
  await save2(engine, fresh, [...msgs, m], {}, { sent: 1, fromSns: m.senderId === SNS_SENDER ? 1 : 0 });
  await engine.metrics.record(q.accountId, q.region, "AWS/SQS", "NumberOfMessagesSent", { QueueName: q.name }, 1, "Count");
  await engine.metrics.record(q.accountId, q.region, "AWS/SQS", "SentMessageSize", { QueueName: q.name }, size, "Bytes");
  return { MessageId: m.messageId, MD5OfMessageBody: m.md5, ...Object.keys(attrs).length ? { MD5OfMessageAttributes: md5OfAttributes(attrs) } : {} };
}
function receiveAttributes(m, names) {
  if (names.length === 0) return void 0;
  const all = {
    SenderId: m.senderId,
    ApproximateFirstReceiveTimestamp: String(m.firstReceivedAt ?? ""),
    ApproximateReceiveCount: String(m.receiveCount),
    SentTimestamp: String(m.sentAt),
    ...m.deadLetterSourceArn ? { DeadLetterQueueSourceArn: m.deadLetterSourceArn } : {}
  };
  if (names.includes("All")) return all;
  return Object.fromEntries(Object.entries(all).filter(([k]) => names.includes(k)));
}
async function receiveMessages(engine, q, input = {}) {
  const max = input.maxNumberOfMessages ?? 1;
  if (!Number.isInteger(max) || max < 1 || max > 10) {
    throw new EngineError("InvalidParameterValue", `Value ${max} for parameter MaxNumberOfMessages is invalid. Reason: Must be between 1 and 10, if provided.`);
  }
  const wait = input.waitTimeSeconds;
  if (wait !== void 0 && (!Number.isInteger(wait) || wait < 0 || wait > 20)) {
    throw new EngineError("InvalidParameterValue", `Value ${wait} for parameter WaitTimeSeconds is invalid. Reason: Must be >= 0 and <= 20, if provided.`);
  }
  const vt = input.visibilityTimeout ?? num2(q, "visibilityTimeout");
  if (!Number.isInteger(vt) || vt < 0 || vt > 43200) throw new EngineError("InvalidParameterValue", `Value ${vt} for parameter VisibilityTimeout is invalid. Reason: Must be >= 0 and <= 43200, if provided.`);
  const now = engine.now().getTime();
  const fresh = await load2(engine, q);
  let msgs = retained(fresh, messagesOf(fresh), now);
  const dlqUrl = fresh.config.deadLetterQueue ? String(fresh.config.deadLetterQueue) : null;
  const maxReceives = Number(fresh.config.maxReceiveCount ?? 10);
  const dlq = dlqUrl ? await engine.get(q.accountId, dlqUrl).catch(() => null) : null;
  const out = [];
  const toDlq = [];
  for (const m of [...msgs].sort((a, b) => a.sentAt - b.sentAt)) {
    if (out.length >= max) break;
    if (m.visibleAt > now) continue;
    if (dlq && m.receiveCount >= maxReceives) {
      toDlq.push(m);
      continue;
    }
    m.receiveCount += 1;
    m.firstReceivedAt ??= now;
    m.receiptHandle = randomBytes(48).toString("base64url");
    m.visibleAt = now + vt * 1e3;
    const wanted = input.messageAttributeNames ?? [];
    const attrs = Object.fromEntries(Object.entries(m.attributes).filter(([k]) => wanted.includes("All") || wanted.includes(".*") || wanted.includes(k)));
    out.push({
      MessageId: m.messageId,
      ReceiptHandle: m.receiptHandle,
      MD5OfBody: m.md5,
      Body: m.body,
      ...input.attributeNames?.length ? { Attributes: receiveAttributes(m, input.attributeNames) } : {},
      ...Object.keys(attrs).length ? { MD5OfMessageAttributes: md5OfAttributes(attrs), MessageAttributes: Object.fromEntries(Object.entries(attrs).map(([k, a]) => [k, { StringValue: a.StringValue, DataType: a.DataType }])) } : {}
    });
  }
  if (toDlq.length) msgs = msgs.filter((m) => !toDlq.includes(m));
  const again = out.filter((o) => (msgs.find((m) => m.messageId === o.MessageId)?.receiveCount ?? 0) > 1).length;
  await save2(engine, fresh, msgs, {}, { received: out.length, redelivered: again, movedToDlq: toDlq.length });
  for (const m of toDlq) {
    await sendMessage(engine, dlq, { body: m.body, attributes: m.attributes, senderId: m.senderId, deadLetterSourceArn: arnOf(fresh), delaySeconds: 0 }).catch(() => void 0);
  }
  const dims = { QueueName: q.name };
  if (out.length) await engine.metrics.record(q.accountId, q.region, "AWS/SQS", "NumberOfMessagesReceived", dims, out.length, "Count");
  else await engine.metrics.record(q.accountId, q.region, "AWS/SQS", "NumberOfEmptyReceives", dims, 1, "Count");
  return { messages: out, movedToDlq: toDlq.length };
}
function byHandle(msgs, handle) {
  if (!handle || handle.length < 20) throw new EngineError("ReceiptHandleIsInvalid", `The input receipt handle "${handle}" is not a valid receipt handle.`);
  return msgs.find((m) => m.receiptHandle === handle);
}
async function deleteMessage(engine, q, handle) {
  const fresh = await load2(engine, q);
  const msgs = messagesOf(fresh);
  const m = byHandle(msgs, handle);
  if (!m) return;
  await save2(engine, fresh, msgs.filter((x) => x !== m), {}, { deleted: 1 });
  await engine.metrics.record(q.accountId, q.region, "AWS/SQS", "NumberOfMessagesDeleted", { QueueName: q.name }, 1, "Count");
}
async function changeVisibility(engine, q, handle, seconds) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 43200) {
    throw new EngineError("InvalidParameterValue", `Value ${seconds} for parameter VisibilityTimeout is invalid. Reason: Must be >= 0 and <= 43200, if provided.`);
  }
  const now = engine.now().getTime();
  const fresh = await load2(engine, q);
  const msgs = messagesOf(fresh);
  const m = byHandle(msgs, handle);
  if (!m || m.visibleAt <= now) {
    throw new EngineError("MessageNotInflight", "Value " + handle + " for parameter ReceiptHandle is invalid. Reason: Message does not exist or is not available for visibility timeout change.");
  }
  m.visibleAt = now + seconds * 1e3;
  await save2(engine, fresh, msgs);
}
async function purgeQueue(engine, q) {
  const now = engine.now().getTime();
  const fresh = await load2(engine, q);
  const last = Number(fresh.attributes.lastPurgeAt ?? 0);
  if (now - last < PURGE_COOLDOWN_MS) {
    throw new EngineError("AWS.SimpleQueueService.PurgeQueueInProgress", `Only one PurgeQueue operation on ${q.name} is allowed every 60 seconds.`, 403);
  }
  await save2(engine, fresh, [], { lastPurgeAt: now });
}
var arr = (v) => v === void 0 ? [] : Array.isArray(v) ? v : [v];
var globMatch = (pattern, value) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i").test(value);
function conditionHolds(cond, sourceArn) {
  if (!cond) return true;
  for (const [op, entries] of Object.entries(cond)) {
    for (const [key, val] of Object.entries(entries)) {
      if (key.toLowerCase() !== "aws:sourcearn") return false;
      const values = arr(val);
      const ok = /^(ArnEquals|StringEquals)$/i.test(op) ? values.some((v) => v === sourceArn) : /^(ArnLike|StringLike)$/i.test(op) ? values.some((v) => globMatch(v, sourceArn)) : false;
      if (!ok) return false;
    }
  }
  return true;
}
function policyAllowsService(q, service, action, sourceArn) {
  if (!q.config.policy) return false;
  let doc;
  try {
    doc = JSON.parse(String(q.config.policy));
  } catch {
    return false;
  }
  const arn = arnOf(q);
  const applies = (s) => {
    const p = s.Principal;
    const principalOk = p === "*" || typeof p === "object" && (arr(p.Service).includes(service) || arr(p.AWS).includes("*"));
    const actionOk = arr(s.Action).some((a) => globMatch(a, action));
    const resourceOk = s.Resource === void 0 || arr(s.Resource).some((r) => globMatch(r, arn));
    return principalOk && actionOk && resourceOk && conditionHolds(s.Condition, sourceArn);
  };
  const statements = arr(doc.Statement);
  if (statements.some((s) => s.Effect === "Deny" && applies(s))) return false;
  return statements.some((s) => s.Effect === "Allow" && applies(s));
}

// src/engine/sqs/attributes.ts
var SETTING_BY_ATTR = Object.fromEntries(Object.entries(QUEUE_SETTINGS).map(([key, s]) => [s.attr, key]));
var READ_ONLY = ["QueueArn", "ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed", "CreatedTimestamp", "LastModifiedTimestamp", "SqsManagedSseEnabled"];
var KNOWN_ATTRIBUTES = [...Object.keys(SETTING_BY_ATTR), "Policy", "RedrivePolicy", ...READ_ONLY];
var arnFromUrl = (url) => {
  const m = /^https?:\/\/[^/]*?(?:sqs\.([a-z0-9-]+)\.[^/]*)?\/(\d{12})\/([^/]+)$/.exec(url);
  return m ? `arn:aws:sqs:${m[1] ?? "local-1"}:${m[2]}:${m[3]}` : url;
};
function attributesToConfig(attrs) {
  const config = {};
  for (const [name, value] of Object.entries(attrs)) {
    const key = SETTING_BY_ATTR[name];
    if (key) {
      const n = Number(value);
      const s = QUEUE_SETTINGS[key];
      if (!/^\d+$/.test(value) || n < s.min || n > s.max) throw new EngineError("InvalidAttributeValue", `Invalid value for the parameter ${name}.`);
      config[key] = n;
    } else if (name === "Policy") {
      config.policy = value === "" ? void 0 : value;
    } else if (name === "RedrivePolicy") {
      if (value === "") {
        config.deadLetterQueue = void 0;
        continue;
      }
      let rp;
      try {
        rp = JSON.parse(value);
      } catch {
        throw new EngineError("InvalidParameterValue", `Value ${value} for parameter RedrivePolicy is invalid. Reason: Redrive policy is not a valid JSON map.`);
      }
      if (!rp.deadLetterTargetArn || !QUEUE_ARN.test(rp.deadLetterTargetArn)) {
        throw new EngineError("InvalidParameterValue", `Value ${value} for parameter RedrivePolicy is invalid. Reason: Invalid value for deadLetterTargetArn.`);
      }
      const count = Number(rp.maxReceiveCount);
      if (!Number.isInteger(count) || count < 1 || count > 1e3) {
        throw new EngineError(
          "InvalidParameterValue",
          `Value ${value} for parameter RedrivePolicy is invalid. Reason: Invalid value for maxReceiveCount: ${rp.maxReceiveCount}, valid values are from 1 to 1000 both inclusive.`
        );
      }
      config.deadLetterQueue = urlFromArn(rp.deadLetterTargetArn);
      config.maxReceiveCount = count;
      config._redrive = value;
    } else if (READ_ONLY.includes(name)) {
      throw new EngineError("InvalidAttributeName", `Unknown Attribute ${name}.`);
    } else if (name === "FifoQueue" || name === "ContentBasedDeduplication") {
      throw new EngineError("InvalidAttributeName", `Unknown Attribute ${name}. (CloudLab simulates standard queues; FIFO queues aren't available yet.)`);
    } else {
      throw new EngineError("InvalidAttributeName", `Unknown Attribute ${name}.`);
    }
  }
  return config;
}
async function checkDeadLetterQueue(config, queueIds2) {
  if (!config.deadLetterQueue) {
    delete config._redrive;
    return;
  }
  const raw = String(config._redrive);
  delete config._redrive;
  const exists = (await queueIds2()).includes(String(config.deadLetterQueue));
  if (!exists) throw new EngineError("InvalidParameterValue", `Value ${raw} for parameter RedrivePolicy is invalid. Reason: Dead letter target does not exist.`);
}
var epoch2 = (iso) => String(Math.floor(Date.parse(iso) / 1e3));
function queueAttributes(q, now) {
  const c = countsOf(q, now);
  return {
    QueueArn: String(q.attributes.arn),
    ApproximateNumberOfMessages: String(c.available),
    ApproximateNumberOfMessagesNotVisible: String(c.inFlight),
    ApproximateNumberOfMessagesDelayed: String(c.delayed),
    CreatedTimestamp: epoch2(q.createdAt),
    LastModifiedTimestamp: epoch2(q.updatedAt),
    VisibilityTimeout: String(q.config.visibilityTimeout),
    MaximumMessageSize: String(q.config.maximumMessageSize),
    MessageRetentionPeriod: String(q.config.messageRetentionPeriod),
    DelaySeconds: String(q.config.delaySeconds),
    ...q.config.policy ? { Policy: JSON.stringify(JSON.parse(String(q.config.policy))) } : {},
    ...q.config.deadLetterQueue ? {
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: arnFromUrl(String(q.config.deadLetterQueue)),
        maxReceiveCount: Number(q.config.maxReceiveCount ?? 10)
      })
    } : {},
    ReceiveMessageWaitTimeSeconds: String(q.config.receiveMessageWaitTimeSeconds),
    SqsManagedSseEnabled: "true"
  };
}

// src/engine/sqs/api.ts
var QueueWaiters = class {
  constructor() {
    this.waiting = /* @__PURE__ */ new Map();
  }
  /** Resolves when notified, or at `until` (ms since 1970), whichever comes first. */
  wait(queueId, until) {
    return new Promise((resolve) => {
      const set = this.waiting.get(queueId) ?? /* @__PURE__ */ new Set();
      this.waiting.set(queueId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.waiting.delete(queueId);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, until - Date.now()));
      set.add(done);
    });
  }
  notify(queueId) {
    for (const done of [...this.waiting.get(queueId) ?? []]) done();
  }
  /** How many receives are waiting (for tests and the console). */
  count(queueId) {
    if (queueId) return this.waiting.get(queueId)?.size ?? 0;
    return [...this.waiting.values()].reduce((n, s) => n + s.size, 0);
  }
};
var JSON_NAMES = {
  "AWS.SimpleQueueService.NonExistentQueue": "QueueDoesNotExist",
  QueueAlreadyExists: "QueueNameExists",
  "AWS.SimpleQueueService.PurgeQueueInProgress": "PurgeQueueInProgress",
  "AWS.SimpleQueueService.TooManyEntriesInBatchRequest": "TooManyEntriesInBatchRequest",
  "AWS.SimpleQueueService.EmptyBatchRequest": "EmptyBatchRequest",
  "AWS.SimpleQueueService.BatchEntryIdsNotDistinct": "BatchEntryIdsNotDistinct",
  "AWS.SimpleQueueService.InvalidBatchEntryId": "InvalidBatchEntryId",
  "AWS.SimpleQueueService.UnsupportedOperation": "UnsupportedOperation",
  "AWS.SimpleQueueService.MessageNotInflight": "MessageNotInflight"
};
function sqsErrorNames(code) {
  return { type: JSON_NAMES[code] ?? code, queryCode: code };
}
var nonExistent = () => new EngineError("AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.", 400);
var missing2 = (param) => new EngineError("MissingParameter", `The request must contain the parameter ${param}.`, 400);
var str2 = (b, param) => {
  const v = b[param];
  if (typeof v !== "string" || !v) throw missing2(param);
  return v;
};
async function queues(ctx) {
  return ctx.host.list(ctx.accountId, { service: "sqs", type: "queue", region: ctx.region });
}
async function byUrl(ctx, url) {
  const name = /\/(\d{12})\/([A-Za-z0-9_-]{1,80})\/?$/.exec(url)?.[2];
  const q = name ? (await queues(ctx)).find((x) => x.name === name) : void 0;
  if (!q) throw nonExistent();
  return q;
}
function messageAttributes(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [name, a] of Object.entries(raw)) {
    if (a?.BinaryValue !== void 0 || a?.DataType?.startsWith("Binary")) {
      throw new EngineError("InvalidParameterValue", `The message attribute '${name}' is Binary: CloudLab keeps String and Number message attributes.`);
    }
    out[name] = { DataType: String(a?.DataType ?? ""), StringValue: a?.StringValue };
  }
  return out;
}
function nextVisible(q, now) {
  const times = (q.attributes.messages ?? []).map((m) => m.visibleAt).filter((t) => t > now);
  return times.length ? Math.min(...times) : null;
}
var MAX_BATCH = 10;
var BATCH_ID = /^[A-Za-z0-9_-]{1,80}$/;
function checkBatch(entries) {
  const list2 = Array.isArray(entries) ? entries : [];
  if (list2.length === 0) throw new EngineError("AWS.SimpleQueueService.EmptyBatchRequest", "There should be at least one SendMessageBatchRequestEntry in the request.", 400);
  if (list2.length > MAX_BATCH) throw new EngineError("AWS.SimpleQueueService.TooManyEntriesInBatchRequest", `Maximum number of entries per request are ${MAX_BATCH}. You have sent ${list2.length}.`, 400);
  const ids = /* @__PURE__ */ new Set();
  for (const e of list2) {
    if (!e.Id || !BATCH_ID.test(e.Id)) {
      throw new EngineError("AWS.SimpleQueueService.InvalidBatchEntryId", "A batch entry id can only contain alphanumeric characters, hyphens and underscores. It can be at most 80 letters long.", 400);
    }
    if (ids.has(e.Id)) throw new EngineError("AWS.SimpleQueueService.BatchEntryIdsNotDistinct", `Id ${e.Id} repeated.`, 400);
    ids.add(e.Id);
  }
  return list2;
}
async function eachEntry(entries, run2) {
  const Successful = [];
  const Failed = [];
  for (const e of entries) {
    try {
      Successful.push({ Id: e.Id, ...await run2(e) });
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      Failed.push({ Id: e.Id, SenderFault: err.status < 500, Code: sqsErrorNames(err.code).type, Message: err.message });
    }
  }
  return { Successful, Failed };
}
function toConfig(attrs) {
  const raw = attrs && typeof attrs === "object" ? attrs : {};
  return attributesToConfig(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])));
}
var queueIds = (ctx) => async () => (await queues(ctx)).map((q) => q.id);
async function send(ctx, q, e) {
  if (typeof e.MessageBody !== "string") throw missing2("MessageBody");
  const r = await sendMessage(ctx.host, q, { body: e.MessageBody, delaySeconds: e.DelaySeconds, attributes: messageAttributes(e.MessageAttributes) });
  ctx.waiters?.notify(q.id);
  return r;
}
var ops2 = {
  async CreateQueue(ctx, body) {
    const name = str2(body, "QueueName");
    const config = toConfig(body.Attributes);
    const existing = (await queues(ctx)).find((q2) => q2.name === name);
    if (existing) {
      const now = queueAttributes(existing, Date.now());
      for (const [k, v] of Object.entries(body.Attributes ?? {})) {
        if (now[k] !== void 0 && String(now[k]) !== String(v)) {
          throw new EngineError("QueueAlreadyExists", `A queue already exists with the same name and a different value for attribute ${k}`, 400);
        }
      }
      return { QueueUrl: ctx.urlOf(existing) };
    }
    await checkDeadLetterQueue(config, queueIds(ctx));
    const q = await ctx.createQueue(Object.fromEntries(Object.entries({ name, ...config }).filter(([, v]) => v !== void 0)));
    return { QueueUrl: ctx.urlOf(q) };
  },
  async GetQueueUrl(ctx, body) {
    const name = str2(body, "QueueName");
    const q = (await queues(ctx)).find((x) => x.name === name);
    if (!q) throw nonExistent();
    return { QueueUrl: ctx.urlOf(q) };
  },
  async ListQueues(ctx, body) {
    const prefix = typeof body.QueueNamePrefix === "string" ? body.QueueNamePrefix : "";
    const max = body.MaxResults === void 0 ? 1e3 : Number(body.MaxResults);
    if (!Number.isInteger(max) || max < 1 || max > 1e3) throw new EngineError("InvalidParameterValue", "Value for parameter MaxResults is invalid. Reason: MaxResults must be an integer between 1 and 1000.", 400);
    const after = typeof body.NextToken === "string" ? Buffer.from(body.NextToken, "base64").toString("utf8") : "";
    const all = (await queues(ctx)).filter((q) => q.name.startsWith(prefix) && q.name > after).sort((a, b) => a.name.localeCompare(b.name));
    const page3 = all.slice(0, max);
    return {
      ...page3.length ? { QueueUrls: page3.map((q) => ctx.urlOf(q)) } : {},
      ...body.MaxResults !== void 0 && all.length > max ? { NextToken: Buffer.from(page3[page3.length - 1].name).toString("base64") } : {}
    };
  },
  async DeleteQueue(ctx, body) {
    const q = await byUrl(ctx, str2(body, "QueueUrl"));
    await ctx.deleteQueue(q);
    ctx.waiters?.notify(q.id);
    return {};
  },
  async GetQueueAttributes(ctx, body) {
    const q = await byUrl(ctx, str2(body, "QueueUrl"));
    const names = Array.isArray(body.AttributeNames) ? body.AttributeNames : [];
    if (names.length === 0) return {};
    const all = queueAttributes(await ctx.host.get(q.accountId, q.id), Date.now());
    if (names.includes("All")) return { Attributes: all };
    for (const n of names) if (!KNOWN_ATTRIBUTES.includes(n) && n !== "RedriveAllowPolicy") throw new EngineError("InvalidAttributeName", `Unknown Attribute ${n}.`, 400);
    const picked = Object.fromEntries(names.filter((n) => n in all).map((n) => [n, all[n]]));
    return Object.keys(picked).length ? { Attributes: picked } : {};
  },
  async SetQueueAttributes(ctx, body) {
    const q = await byUrl(ctx, str2(body, "QueueUrl"));
    const config = toConfig(body.Attributes);
    if (config.deadLetterQueue && config.deadLetterQueue === q.id) {
      throw new EngineError("InvalidParameterValue", "Value for parameter RedrivePolicy is invalid. Reason: Dead letter target cannot be the queue itself.", 400);
    }
    await checkDeadLetterQueue(config, queueIds(ctx));
    await ctx.updateQueue(q, config);
    return {};
  },
  async ListDeadLetterSourceQueues(ctx, body) {
    const q = await byUrl(ctx, str2(body, "QueueUrl"));
    return { queueUrls: (await queues(ctx)).filter((x) => x.config.deadLetterQueue === q.id).map((x) => ctx.urlOf(x)) };
  },
  async SendMessage(ctx, body) {
    const q = await byUrl(ctx, str2(body, "QueueUrl"));
    return send(ctx, q, body);
  },
  async SendMessageBatch(ctx, body) {
    const q = await byUrl(ctx, str2(body, "QueueUrl"));
    const entries = checkBatch(body.Entries);
    return eachEntry(entries, (e) => send(ctx, q, e));
  },
  async ReceiveMessage(ctx, body) {
    const q = await byUrl(ctx, str2(body, "QueueUrl"));
    const wait = body.WaitTimeSeconds === void 0 ? Number(q.config.receiveMessageWaitTimeSeconds ?? 0) : Number(body.WaitTimeSeconds);
    const input = {
      maxNumberOfMessages: body.MaxNumberOfMessages,
      visibilityTimeout: body.VisibilityTimeout,
      waitTimeSeconds: wait,
      attributeNames: [...body.AttributeNames ?? [], ...body.MessageSystemAttributeNames ?? []],
      messageAttributeNames: body.MessageAttributeNames ?? []
    };
    const deadline = Date.now() + wait * 1e3;
    for (; ; ) {
      const r = await receiveMessages(ctx.host, q, input);
      if (r.messages.length || !ctx.waiters || Date.now() >= deadline) return r.messages.length ? { Messages: r.messages } : {};
      const fresh = await ctx.host.get(q.accountId, q.id).catch(() => null);
      if (!fresh) throw nonExistent();
      const soon = nextVisible(fresh, Date.now());
      await ctx.waiters.wait(q.id, soon === null ? deadline : Math.min(deadline, soon + 5));
    }
  },
  async DeleteMessage(ctx, body) {
    const q = await byUrl(ctx, str2(body, "QueueUrl"));
    await deleteMessage(ctx.host, q, str2(body, "ReceiptHandle"));
    return {};
  },
  async DeleteMessageBatch(ctx, body) {
    const q = await byUrl(ctx, str2(body, "QueueUrl"));
    const entries = checkBatch(body.Entries);
    return eachEntry(entries, async (e) => {
      await deleteMessage(ctx.host, q, String(e.ReceiptHandle ?? ""));
      return {};
    });
  },
  async ChangeMessageVisibility(ctx, body) {
    const q = await byUrl(ctx, str2(body, "QueueUrl"));
    await changeVisibility(ctx.host, q, str2(body, "ReceiptHandle"), Number(body.VisibilityTimeout));
    ctx.waiters?.notify(q.id);
    return {};
  },
  async ChangeMessageVisibilityBatch(ctx, body) {
    const q = await byUrl(ctx, str2(body, "QueueUrl"));
    const entries = checkBatch(body.Entries);
    const r = await eachEntry(entries, async (e) => {
      await changeVisibility(ctx.host, q, String(e.ReceiptHandle ?? ""), Number(e.VisibilityTimeout));
      return {};
    });
    ctx.waiters?.notify(q.id);
    return r;
  },
  async PurgeQueue(ctx, body) {
    const q = await byUrl(ctx, str2(body, "QueueUrl"));
    await purgeQueue(ctx.host, q);
    return {};
  },
  async ListQueueTags(ctx, body) {
    await byUrl(ctx, str2(body, "QueueUrl"));
    return {};
  }
};
var SQS_OPERATIONS = Object.keys(ops2);
async function sqsApi(operation, body, ctx) {
  const handler = ops2[operation];
  if (!handler) throw new EngineError("AWS.SimpleQueueService.UnsupportedOperation", `CloudLab's SQS doesn't support ${operation || "this operation"} yet.`, 400);
  return handler(ctx, body && typeof body === "object" && !Array.isArray(body) ? body : {});
}

// src/engine/sqs/console.ts
async function queueConsole(host, q, input, onSent) {
  switch (input.action) {
    case "counts":
      return { counts: countsOf(await host.get(q.accountId, q.id), host.now().getTime()) };
    case "send": {
      const sent = await sendMessage(host, q, { body: input.body, delaySeconds: input.delaySeconds, attributes: input.attributes });
      onSent?.();
      return { sent };
    }
    case "receive":
      return receiveMessages(host, q, {
        maxNumberOfMessages: input.maxNumberOfMessages,
        visibilityTimeout: input.visibilityTimeout,
        attributeNames: ["All"],
        messageAttributeNames: ["All"]
      });
    case "delete":
      await deleteMessage(host, q, input.receiptHandle);
      return { deleted: true };
    case "purge":
      await purgeQueue(host, q);
      return { purged: true };
  }
}

// src/local/sqs-host.ts
var FileQueueHost = class extends FileResourceHost {
  constructor(dir, onChange = () => void 0, now = () => /* @__PURE__ */ new Date()) {
    super(dir, "sqs", "queue", () => NON_EXISTENT(), onChange, now);
  }
  initialAttributes() {
    return { messages: [] };
  }
  /** Receiving edits messages in place (receive count, visibility), so each message is copied; their bodies are shared strings. */
  copy(q) {
    const a = q.attributes;
    const messages = (a.messages ?? []).map((m) => ({ ...m }));
    return { ...q, config: structuredClone(q.config), refs: [...q.refs], attributes: { ...a, messages, stats: { ...a.stats } } };
  }
  specAttributes(spec) {
    return {
      queueUrl: spec.id,
      arn: arnFromUrl(spec.id),
      deadLetterName: spec.config.deadLetterQueue ? String(spec.config.deadLetterQueue).split("/").pop() : null
    };
  }
  /** What CloudLab shows about a queue on this computer: counts, never the messages. */
  report(name) {
    const q = this.peek(name);
    if (!q) return null;
    const c = countsOf(q, this.now().getTime());
    return {
      approximateMessages: c.available,
      approximateInFlight: c.inFlight,
      approximateDelayed: c.delayed,
      stats: statsOf2(q),
      ...q.attributes.lastPurgeAt ? { lastPurgeAt: q.attributes.lastPurgeAt } : {}
    };
  }
};

// src/engine/services/sns.ts
var PROTOCOLS = ["email", "email-json", "lambda", "sqs", "http", "https"];
var KEEP_DELIVERIES = 50;
var KEEP_INBOX = 25;
var topicNameOf = (arn) => arn.split(":").pop() ?? arn;
var invalid2 = (what) => new EngineError("InvalidParameter", `Invalid parameter: ${what}`);
var functionArnOf = (endpoint) => endpoint.split(":").slice(0, 7).join(":");
var NUMERIC_OPS = ["=", "<", "<=", ">", ">="];
function checkFilterPolicy(text) {
  const bad = (why) => invalid2(`FilterPolicy: ${why}`);
  let policy;
  try {
    policy = JSON.parse(text);
  } catch {
    throw bad("failed to parse JSON.");
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw bad("Filter policy must be a JSON object");
  const keys = Object.keys(policy);
  if (keys.length === 0) throw bad("Filter policy can not be empty");
  if (keys.length > 5) throw bad("Filter policy can not have more than 5 keys");
  let combinations = 1;
  for (const [key, value] of Object.entries(policy)) {
    if (!Array.isArray(value)) throw bad(`"${key}" must be an object or an array`);
    if (value.length === 0) throw bad(`Empty arrays are not allowed`);
    combinations *= value.length;
    for (const c of value) {
      if (c === null || typeof c !== "object") continue;
      const [op, arg] = Object.entries(c)[0] ?? [];
      if (Object.keys(c).length !== 1) throw bad(`Unrecognized match type in "${key}"`);
      if (op === "prefix" || op === "suffix" || op === "equals-ignore-case") {
        if (typeof arg !== "string") throw bad(`${op} match pattern must be a string`);
      } else if (op === "exists") {
        if (typeof arg !== "boolean") throw bad("exists match pattern must be either true or false.");
      } else if (op === "anything-but") {
        const ok = typeof arg === "string" || typeof arg === "number" || Array.isArray(arg) && arg.length > 0 || arg && typeof arg === "object" && "prefix" in arg;
        if (!ok) throw bad("Value of anything-but must be an array or single string/number value.");
      } else if (op === "numeric") {
        if (!Array.isArray(arg) || arg.length === 0 || arg.length > 4 || arg.length % 2 !== 0) throw bad("Value of numeric must be an array.");
        for (let i = 0; i < arg.length; i += 2) {
          if (!NUMERIC_OPS.includes(String(arg[i]))) throw bad(`Unrecognized numeric range operator: ${arg[i]}`);
          if (typeof arg[i + 1] !== "number") throw bad(`Value of ${arg[i]} must be numeric`);
        }
      } else {
        throw bad(`Unrecognized match type ${op}`);
      }
    }
  }
  if (combinations > 150) throw bad("Filter policy is too complex");
  return policy;
}
function matchOne(c, value, present) {
  if (c === null || typeof c !== "object") return present && value !== void 0 && String(value) === String(c);
  const [op, arg] = Object.entries(c)[0];
  if (op === "exists") return arg === present;
  if (!present || value === void 0) return false;
  const s = String(value);
  if (op === "prefix") return s.startsWith(String(arg));
  if (op === "suffix") return s.endsWith(String(arg));
  if (op === "equals-ignore-case") return s.toLowerCase() === String(arg).toLowerCase();
  if (op === "anything-but") {
    if (Array.isArray(arg)) return !arg.map(String).includes(s);
    if (arg && typeof arg === "object") return !s.startsWith(String(arg.prefix));
    return s !== String(arg);
  }
  if (op === "numeric") {
    const n = Number(value);
    if (Number.isNaN(n)) return false;
    const a = arg;
    for (let i = 0; i < a.length; i += 2) {
      const t = Number(a[i + 1]);
      const ok = { "=": n === t, "<": n < t, "<=": n <= t, ">": n > t, ">=": n >= t }[String(a[i])];
      if (!ok) return false;
    }
    return true;
  }
  return false;
}
function matchesFilter(policy, attributes) {
  for (const [key, conditions] of Object.entries(policy)) {
    const attr = attributes[key];
    let values = [void 0];
    if (attr) {
      if (attr.DataType === "String.Array") {
        try {
          const arr2 = JSON.parse(attr.StringValue ?? "[]");
          values = Array.isArray(arr2) ? arr2 : [attr.StringValue];
        } catch {
          values = [attr.StringValue];
        }
      } else if (attr.DataType.startsWith("Number")) values = [Number(attr.StringValue)];
      else values = [attr.StringValue];
    }
    const ok = conditions.some((c) => values.some((v) => matchOne(c, v, !!attr)));
    if (!ok) return { match: false, failedKey: key };
  }
  return { match: true };
}
var senderOf = (topic) => `${topic?.config.displayName || "AWS Notifications"} <no-reply@sns.amazonaws.com>`;

// src/engine/sns/publish.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var MAX_MESSAGE_BYTES = 256 * 1024;
function checkInput(input) {
  if (input.message === void 0 || input.message === null || input.message === "") throw invalid2("Empty message");
  if (Buffer.byteLength(input.message) > MAX_MESSAGE_BYTES) throw invalid2("Message too long");
  if (input.subject !== void 0) {
    if (input.subject.length === 0 || input.subject.length > 100 || !/^[\x20-\x7E]+$/.test(input.subject)) throw invalid2("Subject");
  }
  for (const [name, a] of Object.entries(input.attributes ?? {})) {
    if (!a || typeof a.DataType !== "string") throw new EngineError("ParameterValueInvalid", `The message attribute '${name}' must contain non-empty message attribute type.`);
    if (!/^(String|Number|Binary|String\.Array)(\..+)?$/.test(a.DataType)) {
      throw new EngineError("ParameterValueInvalid", `The message attribute '${name}' has an invalid message attribute type, the set of supported type prefixes is Binary, Number, and String.`);
    }
    if (a.StringValue === void 0 || a.StringValue === "") throw new EngineError("ParameterValueInvalid", `The message attribute '${name}' must contain non-empty message attribute value for message attribute type '${a.DataType}'.`);
    if (a.DataType.startsWith("Number") && Number.isNaN(Number(a.StringValue))) {
      throw new EngineError("ParameterValueInvalid", `Could not cast message attribute '${name}' value to number.`);
    }
  }
  if (input.messageStructure === void 0) return { perProtocol: null };
  if (input.messageStructure !== "json") throw invalid2("MessageStructure");
  let parsed;
  try {
    parsed = JSON.parse(input.message);
  } catch {
    throw invalid2("Message Structure - JSON message body failed to parse");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid2("Message Structure - JSON message body failed to parse");
  const map = parsed;
  if (typeof map.default !== "string") throw invalid2("Message Structure - No default entry in JSON message body");
  return { perProtocol: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) };
}
function envelope(topic, messageId, message, subject, attributes, at, sub, base) {
  const host = base ?? `https://sns.${topic.region}.amazonaws.com`;
  return {
    Type: "Notification",
    MessageId: messageId,
    TopicArn: topic.id,
    ...subject !== void 0 ? { Subject: subject } : {},
    Message: message,
    Timestamp: at,
    SignatureVersion: "1",
    Signature: "EXAMPLE",
    SigningCertURL: `${host}/SimpleNotificationService-0000000000000000000000.pem`,
    UnsubscribeURL: `${host}/?Action=Unsubscribe&SubscriptionArn=${sub.id}`,
    ...Object.keys(attributes).length ? { MessageAttributes: Object.fromEntries(Object.entries(attributes).map(([k, a]) => [k, { Type: a.DataType, Value: a.StringValue }])) } : {}
  };
}
async function deliverEmail(engine, sub, topic, email) {
  const inbox = sub.attributes.inbox ?? [];
  const item = { id: randomUUID2(), from: senderOf(topic), kind: "notification", ...email };
  await engine.setAttributes(sub.accountId, sub.id, { inbox: [item, ...inbox].slice(0, KEEP_INBOX) });
}
var footer = (sub) => `

--
If you wish to stop receiving notifications from this topic, please click or visit the link below to unsubscribe:
https://sns.${sub.region}.amazonaws.com/unsubscribe.html?SubscriptionArn=${sub.id}

Please do not reply directly to this email.`;
async function postWithRetries(engine, url, headers, body) {
  let last = "";
  for (const wait of [0, 1e3, 3e3]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const { status } = await engine.deliverHttp(url, headers, body);
      if (status >= 200 && status < 300) return { status: "delivered" };
      last = `The endpoint answered HTTP ${status}.`;
    } catch (e) {
      last = `Couldn't reach the endpoint: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { status: "failed", reason: `${last} (tried 3 times)` };
}
async function deliverOne(engine, topic, sub, m) {
  if (sub.state !== "confirmed") return { status: "pending-confirmation", reason: "Not confirmed yet: open the subscription's inbox and confirm it." };
  if (sub.config.filterPolicy) {
    const f = matchesFilter(checkFilterPolicy(String(sub.config.filterPolicy)), m.attributes);
    if (!f.match) {
      const attr = m.attributes[f.failedKey];
      return {
        status: "filtered",
        reason: attr ? `Filter policy: the message's "${f.failedKey}" (${attr.StringValue}) isn't one the subscription wants.` : `Filter policy: the message has no "${f.failedKey}" attribute.`
      };
    }
  }
  const protocol = String(sub.config.protocol);
  const text = m.text(protocol);
  if (protocol === "email") {
    await deliverEmail(engine, sub, topic, { at: m.at, subject: m.subject ?? "AWS Notification Message", body: text + footer(sub), messageId: m.messageId });
    return { status: "delivered" };
  }
  if (protocol === "email-json") {
    const doc = envelope(topic, m.messageId, text, m.subject, m.attributes, m.at, sub, engine.snsEndpoint);
    await deliverEmail(engine, sub, topic, { at: m.at, subject: m.subject ?? "AWS Notification Message", body: JSON.stringify(doc, null, 2), messageId: m.messageId });
    return { status: "delivered" };
  }
  if (protocol === "http" || protocol === "https") {
    if (!engine.deliverHttp) return { status: "failed", reason: "HTTP(S) endpoints get messages only from My computer (local)." };
    const raw = sub.config.rawMessageDelivery === true;
    const headers = {
      "content-type": "text/plain; charset=UTF-8",
      "user-agent": "Amazon Simple Notification Service Agent",
      "x-amz-sns-message-type": "Notification",
      "x-amz-sns-message-id": m.messageId,
      "x-amz-sns-topic-arn": topic.id,
      "x-amz-sns-subscription-arn": sub.id,
      ...raw ? { "x-amz-sns-rawdelivery": "true" } : {}
    };
    const body = raw ? text : JSON.stringify(envelope(topic, m.messageId, text, m.subject, m.attributes, m.at, sub, engine.snsEndpoint), null, 2);
    return { status: "sending", later: postWithRetries(engine, String(sub.config.endpoint), headers, body) };
  }
  if (protocol === "lambda") {
    const lambda = engine.lambda;
    if (!lambda) return { status: "failed", reason: "Lambda functions don't run on My computer (local) yet." };
    const fnArn = functionArnOf(String(sub.config.endpoint));
    const fn = await engine.get(sub.accountId, fnArn).catch(() => null);
    if (!fn || fn.type !== "function") return { status: "failed", reason: `The function ${fnArn.split(":").pop()} doesn't exist (or is in another account).` };
    if (!lambda.allows(fn, "sns.amazonaws.com", topic.id)) {
      return {
        status: "failed",
        reason: `SNS isn't allowed to invoke ${fn.name}: its resource-based policy needs a statement for sns.amazonaws.com with this topic as the source ARN (aws lambda add-permission).`
      };
    }
    const event = {
      Records: [{ EventSource: "aws:sns", EventVersion: "1.0", EventSubscriptionArn: sub.id, Sns: envelope(topic, m.messageId, text, m.subject, m.attributes, m.at, sub) }]
    };
    try {
      const r = await lambda.invoke(sub.accountId, fn, event, `sns:${topicNameOf(topic.id)}`);
      return r.functionError ? { status: "delivered", reason: `Delivered, but the function failed (see its logs, request ${r.requestId}).` } : { status: "delivered" };
    } catch (e) {
      return { status: "failed", reason: e instanceof EngineError ? `${e.code}: ${e.message}` : String(e) };
    }
  }
  if (protocol === "sqs") {
    const arn = String(sub.config.endpoint);
    const q = await engine.get(sub.accountId, urlFromArn(arn)).catch(() => null);
    if (!q || q.type !== "queue") return { status: "failed", reason: `The queue ${arn.split(":").pop()} doesn't exist (or is in another account).` };
    if (!policyAllowsService(q, "sns.amazonaws.com", "sqs:SendMessage", topic.id)) {
      return {
        status: "failed",
        reason: `SNS isn't allowed to send to ${q.name}: the queue's access policy needs to allow sns.amazonaws.com to sqs:SendMessage, with this topic as aws:SourceArn.`
      };
    }
    const raw = sub.config.rawMessageDelivery === true;
    try {
      await sendMessage(engine, q, {
        body: raw ? text : JSON.stringify(envelope(topic, m.messageId, text, m.subject, m.attributes, m.at, sub, engine.snsEndpoint), null, 2),
        attributes: raw ? Object.fromEntries(Object.entries(m.attributes).filter(([, a]) => a.DataType !== "String.Array")) : {},
        senderId: SNS_SENDER,
        delaySeconds: void 0
      });
      return { status: "delivered" };
    } catch (e) {
      return { status: "failed", reason: e instanceof EngineError ? `${e.code}: ${e.message}` : String(e) };
    }
  }
  return { status: "failed", reason: `CloudLab can't deliver to the ${protocol} protocol yet.` };
}
async function publish(engine, accountId, topic, input) {
  if (topic.region === LOCAL_REGION && !engine.holdsLocalItems) {
    throw new EngineError(
      "LocalTopic",
      `${topic.name} is on your computer (My computer (local)): its subscribers (your queues and apps) are there, so publish from the console on that computer, or with an AWS SDK or the AWS CLI and the endpoint http://localhost:4566.`,
      400
    );
  }
  const { perProtocol } = checkInput(input);
  const messageId = randomUUID2();
  const at = engine.now().toISOString();
  const attributes = input.attributes ?? {};
  const text = (protocol) => perProtocol ? perProtocol[protocol] ?? perProtocol.default : input.message;
  const subs = (await engine.list(accountId, { service: "sns", type: "subscription", region: topic.region })).filter((s) => s.config.topicArn === topic.id);
  const deliveries = [];
  const later = [];
  for (const sub of subs) {
    const { later: pending, ...outcome } = await deliverOne(engine, topic, sub, { messageId, at, subject: input.subject, text, attributes });
    const d = { at, messageId, subject: input.subject, subscriptionArn: sub.id, protocol: String(sub.config.protocol), endpoint: String(sub.config.endpoint), ...outcome };
    deliveries.push(d);
    if (pending) later.push(pending.then((done) => recordLater(engine, accountId, topic, d, done)));
  }
  await updateTopicLog(engine, accountId, topic.id, (fresh) => {
    const previous = fresh.attributes.deliveries ?? [];
    const published = fresh.attributes.published?.count ?? 0;
    return {
      deliveries: [...deliveries, ...previous].slice(0, KEEP_DELIVERIES),
      published: { count: published + 1, lastAt: at, lastMessageId: messageId }
    };
  });
  const dims = { TopicName: topic.name };
  const count = (s) => deliveries.filter((d) => d.status === s).length;
  await engine.metrics.record(accountId, topic.region, "AWS/SNS", "NumberOfMessagesPublished", dims, 1, "Count");
  await engine.metrics.record(accountId, topic.region, "AWS/SNS", "PublishSize", dims, Buffer.byteLength(input.message), "Bytes");
  if (count("delivered")) await engine.metrics.record(accountId, topic.region, "AWS/SNS", "NumberOfNotificationsDelivered", dims, count("delivered"), "Count");
  if (count("failed")) await engine.metrics.record(accountId, topic.region, "AWS/SNS", "NumberOfNotificationsFailed", dims, count("failed"), "Count");
  if (count("filtered")) await engine.metrics.record(accountId, topic.region, "AWS/SNS", "NumberOfNotificationsFilteredOut", dims, count("filtered"), "Count");
  return { messageId, deliveries, settled: Promise.all(later).then(() => void 0) };
}
var topicLogs = /* @__PURE__ */ new Map();
function updateTopicLog(engine, accountId, topicId, change) {
  const run2 = (topicLogs.get(topicId) ?? Promise.resolve()).then(async () => {
    const fresh = await engine.get(accountId, topicId).catch(() => null);
    if (fresh) await engine.setAttributes(accountId, topicId, change(fresh));
  });
  const tail = run2.catch(() => void 0);
  topicLogs.set(topicId, tail);
  void tail.then(() => {
    if (topicLogs.get(topicId) === tail) topicLogs.delete(topicId);
  });
  return run2;
}
async function recordLater(engine, accountId, topic, d, done) {
  Object.assign(d, done);
  await updateTopicLog(engine, accountId, topic.id, (fresh) => ({
    deliveries: (fresh.attributes.deliveries ?? []).map((x) => x.messageId === d.messageId && x.subscriptionArn === d.subscriptionArn ? { ...x, ...done } : x)
  }));
  const metric = done.status === "delivered" ? "NumberOfNotificationsDelivered" : "NumberOfNotificationsFailed";
  await engine.metrics.record(accountId, topic.region, "AWS/SNS", metric, { TopicName: topic.name }, 1, "Count");
}
function subscriptionConfirmation(topicArn, sub, base, at) {
  const token = String(sub.attributes.token ?? "");
  const messageId = randomUUID2();
  const body = {
    Type: "SubscriptionConfirmation",
    MessageId: messageId,
    Token: token,
    TopicArn: topicArn,
    Message: `You have chosen to subscribe to the topic ${topicArn}.
To confirm the subscription, visit the SubscribeURL included in this message.`,
    SubscribeURL: `${base}/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topicArn)}&Token=${token}`,
    Timestamp: at,
    SignatureVersion: "1",
    Signature: "EXAMPLE",
    SigningCertURL: `${base}/SimpleNotificationService-0000000000000000000000.pem`
  };
  const headers = {
    "content-type": "text/plain; charset=UTF-8",
    "user-agent": "Amazon Simple Notification Service Agent",
    "x-amz-sns-message-type": "SubscriptionConfirmation",
    "x-amz-sns-message-id": messageId,
    "x-amz-sns-topic-arn": topicArn
  };
  return { headers, body: JSON.stringify(body, null, 2) };
}

// src/engine/sns/api.ts
function list(p, prefix) {
  const out = [];
  for (let i = 1; ; i++) {
    const head = `${prefix}.${i}.`;
    const entry = new Map([...p].filter(([k]) => k.startsWith(head)).map(([k, v]) => [k.slice(head.length), v]));
    if (entry.size === 0) return out;
    out.push(entry);
  }
}
var attributeMap = (p, prefix = "Attributes.entry") => Object.fromEntries(list(p, prefix).map((e) => [e.get("key") ?? "", e.get("value") ?? ""]));
function messageAttributes2(p, prefix = "MessageAttributes.entry") {
  const out = {};
  for (const e of list(p, prefix)) {
    const name = e.get("Name") ?? "";
    if (e.has("Value.BinaryValue")) throw new EngineError("ParameterValueInvalid", `The message attribute '${name}' is Binary: CloudLab keeps String and Number message attributes.`);
    out[name] = { DataType: e.get("Value.DataType") ?? "", StringValue: e.get("Value.StringValue") };
  }
  return out;
}
var XmlMap = class {
  constructor(entries) {
    this.entries = entries;
  }
};
var esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
function toXml(name, v) {
  if (v === void 0 || v === null) return "";
  if (v instanceof XmlMap) return `<${name}>${Object.entries(v.entries).map(([k, x]) => `<entry><key>${esc(k)}</key><value>${esc(x)}</value></entry>`).join("")}</${name}>`;
  if (Array.isArray(v)) return `<${name}>${v.map((x) => toXml("member", x)).join("")}</${name}>`;
  if (typeof v === "object") return `<${name}>${Object.entries(v).map(([k, x]) => toXml(k, x)).join("")}</${name}>`;
  return `<${name}>${esc(v)}</${name}>`;
}
var XMLNS = "http://sns.amazonaws.com/doc/2010-03-31/";
function snsResponseXml(action, result, requestId) {
  const inner = Object.keys(result).length ? toXml(`${action}Result`, result) : "";
  return `<?xml version="1.0"?>
<${action}Response xmlns="${XMLNS}">${inner}<ResponseMetadata><RequestId>${requestId}</RequestId></ResponseMetadata></${action}Response>`;
}
function snsErrorXml(code, message, status, requestId) {
  return `<?xml version="1.0"?>
<ErrorResponse xmlns="${XMLNS}"><Error><Type>${status >= 500 ? "Receiver" : "Sender"}</Type><Code>${esc(code)}</Code><Message>${esc(message)}</Message></Error><RequestId>${requestId}</RequestId></ErrorResponse>`;
}
var notFound = (what) => new EngineError("NotFound", `${what} does not exist`, 404);
function required(p, name) {
  const v = p.get(name);
  if (v === void 0 || v === "") throw invalid2(name);
  return v;
}
var ownerOf = (arn) => arn.split(":")[4] ?? "";
async function topics(ctx) {
  return ctx.host.list(ctx.accountId, { service: "sns", type: "topic", region: ctx.region });
}
async function subscriptions(ctx) {
  return ctx.host.list(ctx.accountId, { service: "sns", type: "subscription", region: ctx.region });
}
async function topicByArn(ctx, arn) {
  const t = (await topics(ctx)).find((x) => x.id === arn);
  if (!t) throw notFound("Topic");
  return t;
}
async function subByArn(ctx, arn) {
  const s = (await subscriptions(ctx)).find((x) => x.id === arn);
  if (!s) throw notFound("Subscription");
  return s;
}
function defaultPolicy(t) {
  const account = ownerOf(t.id);
  return JSON.stringify({
    Version: "2008-10-17",
    Id: "__default_policy_ID",
    Statement: [
      {
        Sid: "__default_statement_ID",
        Effect: "Allow",
        Principal: { AWS: "*" },
        Action: ["SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission", "SNS:RemovePermission", "SNS:DeleteTopic", "SNS:Subscribe", "SNS:ListSubscriptionsByTopic", "SNS:Publish"],
        Resource: t.id,
        Condition: { StringEquals: { "AWS:SourceOwner": account } }
      }
    ]
  });
}
var listedArn = (s) => s.state === "confirmed" ? s.id : "PendingConfirmation";
var subMember = (s) => ({ SubscriptionArn: listedArn(s), Owner: ownerOf(s.id), Protocol: s.config.protocol, Endpoint: s.config.endpoint, TopicArn: s.config.topicArn });
function page2(items, p) {
  const start = Number(p.get("NextToken") ?? 0) || 0;
  const slice = items.slice(start, start + 100);
  return { slice, next: start + 100 < items.length ? String(start + 100) : void 0 };
}
function subscriptionSettings(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "FilterPolicy") {
      if (v) checkFilterPolicy(v);
      out.filterPolicy = v || void 0;
    } else if (k === "RawMessageDelivery") {
      if (!/^(true|false)$/i.test(v)) throw invalid2("RawMessageDelivery: Invalid value [" + v + "]. Must be true or false.");
      out.rawMessageDelivery = v.toLowerCase() === "true";
    } else if (k === "FilterPolicyScope") {
      if (v !== "MessageAttributes") throw invalid2("FilterPolicyScope: CloudLab filters on MessageAttributes.");
    } else {
      throw invalid2(`AttributeName (CloudLab supports FilterPolicy and RawMessageDelivery)`);
    }
  }
  return out;
}
async function publishOne(ctx, topic, p, attrsPrefix = "MessageAttributes.entry") {
  const message = p.get("Message");
  if (message === void 0) throw invalid2("Message");
  const r = await publish(ctx.host, ctx.accountId, topic, {
    message,
    subject: p.get("Subject"),
    messageStructure: p.get("MessageStructure"),
    attributes: messageAttributes2(p, attrsPrefix)
  });
  return r.messageId;
}
var ops3 = {
  async CreateTopic(ctx, p) {
    const name = required(p, "Name");
    const attrs = attributeMap(p);
    if (attrs.FifoTopic === "true" || name.endsWith(".fifo")) throw invalid2("Topic Name (CloudLab simulates standard topics; FIFO topics aren't available yet)");
    const existing = (await topics(ctx)).find((t2) => t2.name === name);
    if (existing) {
      if (attrs.DisplayName !== void 0 && attrs.DisplayName !== (existing.config.displayName ?? "")) throw invalid2("Topic already exists with different attributes");
      return { TopicArn: existing.id };
    }
    for (const k of Object.keys(attrs)) if (!["DisplayName", "FifoTopic"].includes(k)) throw invalid2(`Attributes Reason: ${k} (CloudLab supports DisplayName)`);
    const t = await ctx.createTopic({ name, ...attrs.DisplayName ? { displayName: attrs.DisplayName } : {} });
    return { TopicArn: t.id };
  },
  async ListTopics(ctx, p) {
    const all = (await topics(ctx)).sort((a, b) => a.id.localeCompare(b.id));
    const { slice, next } = page2(all, p);
    return { Topics: slice.map((t) => ({ TopicArn: t.id })), ...next ? { NextToken: next } : {} };
  },
  async DeleteTopic(ctx, p) {
    const arn = required(p, "TopicArn");
    const t = (await topics(ctx)).find((x) => x.id === arn);
    if (t) await ctx.deleteTopic(t);
    return {};
  },
  async GetTopicAttributes(ctx, p) {
    const t = await topicByArn(ctx, required(p, "TopicArn"));
    const subs = (await subscriptions(ctx)).filter((s) => s.config.topicArn === t.id);
    return {
      Attributes: new XmlMap({
        TopicArn: t.id,
        Owner: ownerOf(t.id),
        DisplayName: String(t.config.displayName ?? ""),
        Policy: defaultPolicy(t),
        SubscriptionsConfirmed: String(subs.filter((s) => s.state === "confirmed").length),
        SubscriptionsPending: String(subs.filter((s) => s.state !== "confirmed").length),
        SubscriptionsDeleted: "0",
        EffectiveDeliveryPolicy: JSON.stringify({ http: { defaultHealthyRetryPolicy: { minDelayTarget: 1, maxDelayTarget: 3, numRetries: 2, numMaxDelayRetries: 0, numNoDelayRetries: 0, numMinDelayRetries: 0, backoffFunction: "linear" }, disableSubscriptionOverrides: false } })
      })
    };
  },
  async SetTopicAttributes(ctx, p) {
    const t = await topicByArn(ctx, required(p, "TopicArn"));
    const name = required(p, "AttributeName");
    if (name !== "DisplayName") throw invalid2(`AttributeName (CloudLab supports DisplayName)`);
    await ctx.updateTopic(t, { displayName: p.get("AttributeValue") ?? "" });
    return {};
  },
  async Subscribe(ctx, p) {
    const topic = await topicByArn(ctx, required(p, "TopicArn"));
    const protocol = required(p, "Protocol").toLowerCase();
    if (!PROTOCOLS.includes(protocol)) throw invalid2("Invalid protocol type: " + protocol);
    const endpoint = p.get("Endpoint");
    if (!endpoint) throw invalid2("Endpoint");
    const settings = subscriptionSettings(attributeMap(p));
    const same = (await subscriptions(ctx)).find((s) => s.config.topicArn === topic.id && s.config.protocol === protocol && s.config.endpoint === endpoint);
    const sub = same ?? await ctx.subscribe({ topicArn: topic.id, protocol, endpoint, ...settings });
    const returnArn = (p.get("ReturnSubscriptionArn") ?? "false").toLowerCase() === "true";
    return { SubscriptionArn: sub.state === "confirmed" || returnArn ? sub.id : "pending confirmation" };
  },
  async ConfirmSubscription(ctx, p) {
    const topic = await topicByArn(ctx, required(p, "TopicArn"));
    const sub = await ctx.confirm(topic.id, required(p, "Token"));
    return { SubscriptionArn: sub.id };
  },
  async Unsubscribe(ctx, p) {
    const sub = await subByArn(ctx, required(p, "SubscriptionArn"));
    await ctx.unsubscribe(sub);
    return {};
  },
  async ListSubscriptions(ctx, p) {
    const { slice, next } = page2((await subscriptions(ctx)).sort((a, b) => a.id.localeCompare(b.id)), p);
    return { Subscriptions: slice.map(subMember), ...next ? { NextToken: next } : {} };
  },
  async ListSubscriptionsByTopic(ctx, p) {
    const topic = await topicByArn(ctx, required(p, "TopicArn"));
    const { slice, next } = page2((await subscriptions(ctx)).filter((s) => s.config.topicArn === topic.id), p);
    return { Subscriptions: slice.map(subMember), ...next ? { NextToken: next } : {} };
  },
  async GetSubscriptionAttributes(ctx, p) {
    const s = await subByArn(ctx, required(p, "SubscriptionArn"));
    return {
      Attributes: new XmlMap({
        SubscriptionArn: s.id,
        TopicArn: String(s.config.topicArn),
        Owner: ownerOf(s.id),
        Protocol: String(s.config.protocol),
        Endpoint: String(s.config.endpoint),
        ConfirmationWasAuthenticated: "false",
        PendingConfirmation: String(s.state !== "confirmed"),
        RawMessageDelivery: String(s.config.rawMessageDelivery === true),
        ...s.config.filterPolicy ? { FilterPolicy: String(s.config.filterPolicy), FilterPolicyScope: "MessageAttributes" } : {}
      })
    };
  },
  async SetSubscriptionAttributes(ctx, p) {
    const s = await subByArn(ctx, required(p, "SubscriptionArn"));
    await ctx.updateSubscription(s, subscriptionSettings({ [required(p, "AttributeName")]: p.get("AttributeValue") ?? "" }));
    return {};
  },
  async Publish(ctx, p) {
    const arn = p.get("TopicArn") ?? p.get("TargetArn");
    if (!arn) throw invalid2("TopicArn or TargetArn Reason: no value for required parameter");
    if (p.get("PhoneNumber")) throw invalid2("PhoneNumber (CloudLab doesn't send SMS)");
    return { MessageId: await publishOne(ctx, await topicByArn(ctx, arn), p) };
  },
  async PublishBatch(ctx, p) {
    const topic = await topicByArn(ctx, required(p, "TopicArn"));
    const entries = list(p, "PublishBatchRequestEntries.member");
    if (entries.length === 0) throw new EngineError("EmptyBatchRequest", "The batch request doesn't contain any entries.", 400);
    if (entries.length > 10) throw new EngineError("TooManyEntriesInBatchRequest", "The batch request contains more entries than permissible.", 400);
    const ids = entries.map((e) => e.get("Id") ?? "");
    if (new Set(ids).size !== ids.length) throw new EngineError("BatchEntryIdsNotDistinct", "Two or more batch entries in the request have the same Id.", 400);
    const Successful = [];
    const Failed = [];
    for (const e of entries) {
      try {
        Successful.push({ Id: e.get("Id"), MessageId: await publishOne(ctx, topic, e) });
      } catch (err) {
        if (!(err instanceof EngineError)) throw err;
        Failed.push({ Id: e.get("Id"), Code: err.code, Message: err.message, SenderFault: true });
      }
    }
    return { Successful, Failed };
  },
  async ListTagsForResource() {
    return { Tags: [] };
  }
};
var SNS_OPERATIONS = Object.keys(ops3);
var SNS_UNSIGNED = ["ConfirmSubscription", "Unsubscribe"];
async function snsApi(params, ctx) {
  const action = params.get("Action") ?? "";
  const handler = ops3[action];
  if (!handler) throw new EngineError("InvalidAction", action ? `CloudLab's SNS doesn't support ${action} yet.` : "Could not find operation", 400);
  return { action, result: await handler(ctx, params) };
}

// src/local/sns-host.ts
var notFound2 = (what) => () => new EngineError("NotFound", `${what} does not exist`, 404);
var FileTopicHost = class extends FileResourceHost {
  constructor(dir, onChange = () => void 0, now = () => /* @__PURE__ */ new Date()) {
    super(dir, "sns", "topic", notFound2("Topic"), onChange, now);
  }
  /** What CloudLab shows on the topic's page: the delivery log (who got what, no message bodies) and counts. */
  report(name) {
    const t = this.peek(name);
    return t ? { deliveries: t.attributes.deliveries ?? [], published: t.attributes.published ?? null } : null;
  }
};
var FileSubscriptionHost = class extends FileResourceHost {
  constructor(dir, onChange = () => void 0, now = () => /* @__PURE__ */ new Date()) {
    super(dir, "sns", "subscription", notFound2("Subscription"), onChange, now);
  }
  specAttributes(spec) {
    return spec.attributes?.token ? { token: spec.attributes.token, topicName: spec.attributes.topicName } : {};
  }
  report(name) {
    const s = this.peek(name);
    return s ? { inbox: s.attributes.inbox ?? [] } : null;
  }
};
var LocalHosts = class {
  constructor(hosts, now = () => /* @__PURE__ */ new Date(), deliverHttp, snsEndpoint) {
    this.hosts = hosts;
    this.now = now;
    this.deliverHttp = deliverHttp;
    this.snsEndpoint = snsEndpoint;
    this.holdsLocalItems = true;
    this.metrics = { record: async () => void 0 };
  }
  owner(id) {
    const h = this.hosts.find((x) => x.owns(id));
    if (!h) throw new EngineError("NotFound", `${id.split(/[/:]/).pop()} does not exist`, 404);
    return h;
  }
  get(accountId, id) {
    return this.owner(id).get(accountId, id);
  }
  async list(accountId, filter) {
    const all = await Promise.all(this.hosts.filter((h) => (!filter.service || h.service === filter.service) && (!filter.type || h.type === filter.type)).map((h) => h.list(accountId, filter)));
    return all.flat();
  }
  async setAttributes(accountId, id, patch) {
    const h = this.hosts.find((x) => x.owns(id));
    if (h) await h.setAttributes(accountId, id, patch);
  }
  countInWindow(key, windowMs) {
    return this.hosts[0].countInWindow(key, windowMs);
  }
};
export {
  DYNAMODB_OPERATIONS,
  EngineError,
  FileQueueHost,
  FileSubscriptionHost,
  FileTableHost,
  FileTopicHost,
  LocalHosts,
  QueueWaiters,
  SNS_UNSIGNED,
  dynamodbApi,
  explore,
  publish,
  queueConsole,
  snsApi,
  snsErrorXml,
  snsResponseXml,
  sqsApi,
  sqsErrorNames,
  subscriptionConfirmation
};
