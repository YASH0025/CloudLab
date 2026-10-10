import { search } from "jmespath";

/**
 * --query and --output, as the real CLI applies them to a command's result.
 * Common use: `aws ec2 create-key-pair --key-name k --query KeyMaterial --output text`.
 */

export class QueryError extends Error {}

export function applyQuery(result: unknown, query: string | undefined): unknown {
  if (!query || result === undefined) return result;
  try {
    return search(result, query);
  } catch (e) {
    throw new QueryError(`Bad value for --query ${query}: ${(e as Error).message}`);
  }
}

const scalar = (v: unknown) => (v === null || v === undefined ? "None" : typeof v === "object" ? JSON.stringify(v) : String(v));
const isScalar = (v: unknown) => v === null || typeof v !== "object";

/** The CLI's text format: scalars tab-separated, nested lists and objects on their own lines. */
function toText(value: unknown, key?: string): string[] {
  if (isScalar(value)) return [scalar(value)];
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return [value.map(scalar).join("\t")];
    return value.flatMap((v) => toText(v, key));
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  const flat = entries.filter(([, v]) => isScalar(v)).map(([, v]) => scalar(v));
  const lines = flat.length ? [[...(key ? [key.toUpperCase()] : []), ...flat].join("\t")] : [];
  for (const [k, v] of entries.filter(([, v]) => !isScalar(v))) lines.push(...toText(v, k));
  return lines;
}

export function formatOutput(result: unknown, output: string | undefined): string {
  if (result === undefined) return "";
  if (output === "text" || output === "table") return toText(result).join("\n");
  return JSON.stringify(result, null, 4);
}
