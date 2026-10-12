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
  let charCodes = Uint8Array.from(alphabet, (str2) => {
    return str2.charCodeAt(0);
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
        let randomBytes = Buffer.allocUnsafe(
          Math.ceil(1.6 * (mask + 1) * target / alphabetLen)
        );
        let accepted = 0;
        while (accepted < target) {
          fillRandom(randomBytes);
          for (let i = 0; i < randomBytes.length; i++) {
            let index = randomBytes[i] & mask;
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
function itemSize(item) {
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
async function save(engine, t, items, add = {}) {
  const stats = statsOf(t);
  for (const [k, v] of Object.entries(add)) stats[k] += v ?? 0;
  const bytes = Object.values(items).reduce((n, it) => n + itemSize(it), 0);
  await engine.setAttributes(t.accountId, t.id, { items, itemCount: Object.keys(items).length, tableSizeBytes: bytes, stats });
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
function checkLimits(items) {
  if (Object.keys(items).length > MAX_ITEMS) throw new EngineError("LimitExceededException", `CloudLab keeps at most ${MAX_ITEMS} items per table. Delete some first.`, 400);
  if (Object.values(items).reduce((n, it) => n + itemSize(it), 0) > MAX_TABLE_BYTES) throw new EngineError("LimitExceededException", "CloudLab keeps at most 4 MB per table. Delete some items first.", 400);
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
  items[k] = item;
  checkLimits(items);
  await save(engine, t, items, { writes: 1 });
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
  if (old) {
    delete items[k];
    await save(engine, t, items, { writes: 1 });
  }
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
  items[k] = updated;
  checkLimits(items);
  await save(engine, t, items, { writes: 1 });
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
    const num2 = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(rest);
    if (num2 && !(ch === "-" && out.length && ["num", "ident", "qident", "str"].includes(out[out.length - 1].k))) {
      out.push({ k: "num", v: num2[0] });
      i += num2[0].length;
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
    const page2 = rest.slice(0, limit);
    return { TableNames: page2, ...rest.length > limit ? { LastEvaluatedTableName: page2[page2.length - 1] } : {} };
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
    const list = body.TransactItems ?? [];
    if (!list.length || list.length > MAX_TRANSACT) throw validation(`1 validation error detected: Value at 'transactItems' failed to satisfy constraint: Member must have length less than or equal to ${MAX_TRANSACT}`);
    const steps = await Promise.all(
      list.map(async (x) => {
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
    for (const s of steps) if (!before.has(s.t.id)) before.set(s.t.id, await ctx.host.get(s.t.accountId, s.t.id));
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
    const list = body.TransactItems ?? [];
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
    const r = await executeStatement(ctx.host, ctx.accountId, ctx.region, str(body, "Statement"), body.Parameters ?? []);
    return { Items: r.Items ?? [] };
  },
  async BatchExecuteStatement(ctx, body) {
    const list = body.Statements ?? [];
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

// src/local/dynamodb-host.ts
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
var FILE = /^[a-zA-Z0-9_.-]{3,255}\.json$/;
var FileTableHost = class {
  constructor(dir, onChange = () => void 0, now = () => /* @__PURE__ */ new Date()) {
    this.dir = dir;
    this.onChange = onChange;
    this.now = now;
    this.holdsLocalItems = true;
    this.tables = /* @__PURE__ */ new Map();
    this.calls = /* @__PURE__ */ new Map();
    this.metrics = { record: async () => void 0 };
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!FILE.test(f)) continue;
      try {
        const t = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
        if (t?.name && t.config) this.tables.set(t.name, t);
      } catch {
      }
    }
  }
  file(name) {
    return path.join(this.dir, `${name}.json`);
  }
  save(t) {
    const tmp = `${this.file(t.name)}.tmp`;
    writeFileSync(tmp, JSON.stringify(t));
    renameSync(tmp, this.file(t.name));
  }
  /** Creates the table, or brings its settings up to date. Items are kept. */
  upsert(spec) {
    const old = this.tables.get(spec.name);
    const now = this.now().toISOString();
    const t = {
      id: spec.id,
      accountId: "local",
      region: LOCAL_REGION,
      service: "dynamodb",
      type: "table",
      name: spec.name,
      state: "ACTIVE",
      pendingState: null,
      transitionAt: null,
      config: { ...spec.config, name: spec.name },
      attributes: { items: {}, itemCount: 0, tableSizeBytes: 0, ...old?.attributes ?? {}, arn: spec.id },
      refs: [],
      createdAt: old?.createdAt ?? spec.createdAt ?? now,
      updatedAt: now
    };
    this.tables.set(t.name, t);
    this.save(t);
    return t;
  }
  remove(name) {
    this.tables.delete(name);
    rmSync(this.file(name), { force: true });
  }
  has(name) {
    return this.tables.has(name);
  }
  names() {
    return [...this.tables.keys()];
  }
  byName(name) {
    const t = this.tables.get(name);
    if (!t) throw tableNotFound(name);
    return structuredClone(t);
  }
  report(name) {
    const t = this.tables.get(name);
    if (!t) return null;
    const a = t.attributes;
    return { itemCount: Number(a.itemCount ?? 0), tableSizeBytes: Number(a.tableSizeBytes ?? 0), stats: a.stats ?? {}, ...a.throttledAt ? { throttledAt: a.throttledAt } : {} };
  }
  /** Where a table's file is (shown in the console). */
  pathOf(name) {
    return this.file(name);
  }
  // ---------- TableHost ----------
  async get(_accountId, id) {
    const t = [...this.tables.values()].find((x) => x.id === id || x.name === id);
    if (!t) throw tableNotFound(id.split("/").pop() ?? id);
    return structuredClone(t);
  }
  async list(_accountId, filter) {
    if (filter.service && filter.service !== "dynamodb" || filter.type && filter.type !== "table") return [];
    if (filter.region && filter.region !== LOCAL_REGION) return [];
    return [...this.tables.values()].map((t) => structuredClone(t));
  }
  async setAttributes(_accountId, id, patch) {
    const t = [...this.tables.values()].find((x) => x.id === id);
    if (!t) return;
    t.attributes = { ...t.attributes, ...patch };
    t.updatedAt = this.now().toISOString();
    this.save(t);
    this.onChange(t);
  }
  async countInWindow(key, windowMs) {
    const now = this.now().getTime();
    const recent = (this.calls.get(key) ?? []).filter((at) => at > now - windowMs);
    recent.push(now);
    this.calls.set(key, recent);
    return recent.length;
  }
};
export {
  DYNAMODB_OPERATIONS,
  EngineError,
  FileTableHost,
  dynamodbApi,
  explore
};
