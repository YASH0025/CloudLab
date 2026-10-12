import { EngineError } from "../errors";

/**
 * CloudWatch Logs filter patterns, the common forms:
 *   ERROR                    events containing ERROR (case-sensitive)
 *   ERROR timeout            both terms
 *   "connection refused"     an exact phrase
 *   ?ERROR ?WARN             either term
 *   ERROR -healthcheck       ERROR but not healthcheck
 *   { $.level = "error" }    JSON events whose field matches (=, !=, <, >, <=, >=, * wildcard, && and ||)
 * An empty pattern matches everything.
 */
export function compileFilter(pattern: string | undefined): (message: string) => boolean {
  const p = (pattern ?? "").trim();
  if (!p || p === '""') return () => true;
  if (p.startsWith("{")) return compileJson(p);
  if (p.startsWith("[")) {
    throw new EngineError("InvalidParameterException", "CloudLab supports term, phrase and JSON filter patterns; space-delimited [w1, w2] patterns aren't simulated yet.");
  }

  const tokens: string[] = [];
  const re = /(\??-?)"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p))) tokens.push(m[2] !== undefined ? `${m[1]}\u0000${m[2].replace(/\\"/g, '"')}` : m[3]);

  const any: string[] = [];
  const all: string[] = [];
  const none: string[] = [];
  for (const t of tokens) {
    const quoted = t.includes("\u0000");
    const [prefix, word] = quoted ? t.split("\u0000") : [t.match(/^\??-?/)![0], t.replace(/^\??-?/, "")];
    if (!word) throw new EngineError("InvalidParameterException", "Invalid filter pattern");
    if (prefix.startsWith("?")) any.push(word);
    else if (prefix === "-") none.push(word);
    else all.push(word);
  }
  return (msg) => all.every((w) => msg.includes(w)) && (any.length === 0 || any.some((w) => msg.includes(w))) && !none.some((w) => msg.includes(w));
}

type Cond = (doc: unknown) => boolean;

function compileJson(p: string): (message: string) => boolean {
  const body = p.replace(/^\{\s*/, "").replace(/\s*\}$/, "");
  const orParts = body.split(/\s*\|\|\s*/);
  const ors: Cond[][] = orParts.map((part) => part.split(/\s*&&\s*/).map(compileCondition));
  return (msg) => {
    let doc: unknown;
    try {
      doc = JSON.parse(msg.slice(msg.indexOf("{")));
    } catch {
      return false;
    }
    return ors.some((ands) => ands.every((c) => c(doc)));
  };
}

function compileCondition(expr: string): Cond {
  const m = /^\(?\s*\$((?:\.[\w-]+|\[\d+\])+)\s*(=|!=|<=|>=|<|>)\s*(.+?)\s*\)?$/.exec(expr);
  if (!m) throw new EngineError("InvalidParameterException", `Invalid filter pattern: ${expr}`);
  const path = [...m[1].matchAll(/\.([\w-]+)|\[(\d+)\]/g)].map((x) => x[1] ?? Number(x[2]));
  const op = m[2];
  const raw = m[3];
  const get = (doc: unknown) => path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string | number, unknown>)[k] : undefined), doc);
  if (/^".*"$/.test(raw) || /^[A-Za-z_*][\w*.-]*$/.test(raw)) {
    const text = raw.replace(/^"|"$/g, "");
    if (raw === "NULL") return (d) => (op === "=" ? get(d) === null : get(d) !== null);
    if (raw === "TRUE" || raw === "FALSE") return (d) => (op === "=") === (get(d) === (raw === "TRUE"));
    const wildcard = new RegExp(`^${text.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    if (op !== "=" && op !== "!=") throw new EngineError("InvalidParameterException", `Invalid filter pattern: ${expr}`);
    return (d) => {
      const v = get(d);
      const match = v !== undefined && wildcard.test(String(v));
      return op === "=" ? match : !match;
    };
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) throw new EngineError("InvalidParameterException", `Invalid filter pattern: ${expr}`);
  return (d) => {
    const v = Number(get(d));
    if (!Number.isFinite(v)) return false;
    return op === "=" ? v === num : op === "!=" ? v !== num : op === "<" ? v < num : op === ">" ? v > num : op === "<=" ? v <= num : v >= num;
  };
}
