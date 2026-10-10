/**
 * Turns a command line into tokens and then into the pieces the AWS CLI
 * works with: service, operation, and --options.
 */

export class UsageError extends Error {}

/** Splits a command line like a shell would: whitespace separates, quotes group, backslash escapes. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote) throw new UsageError(`unterminated ${quote === '"' ? "double" : "single"} quote`);
  if (inToken) tokens.push(current);
  return tokens;
}

export interface ParsedCommand {
  service: string;
  operation: string;
  /** Positional arguments after the operation (e.g. s3://bucket for `aws s3 mb`). */
  positionals: string[];
  /** Option name (without --) → values. A flag with no value has an empty list. */
  options: Map<string, string[]>;
  region?: string;
  /** --query: a JMESPath expression applied to the output. */
  query?: string;
  /** --output: json (default), text, table or yaml. */
  output?: string;
}

/** Global options the AWS CLI accepts anywhere on the line. */
const GLOBAL_WITH_VALUE = new Set(["region", "output", "profile", "query", "endpoint-url"]);

export function parseAws(tokens: string[]): ParsedCommand {
  if (tokens[0] !== "aws") throw new UsageError("commands must start with 'aws'");
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  let region: string | undefined;
  let query: string | undefined;
  let output: string | undefined;

  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith("--") && t.length > 2) {
      let name = t.slice(2);
      const values: string[] = [];
      const eq = name.indexOf("=");
      if (eq !== -1) {
        values.push(name.slice(eq + 1));
        name = name.slice(0, eq);
        i++;
      } else {
        i++;
        while (i < tokens.length && !(tokens[i].startsWith("--") && tokens[i].length > 2)) {
          // Positionals for high-level s3 commands come before options, so stop collecting
          // values for global options after one.
          values.push(tokens[i]);
          i++;
          if (GLOBAL_WITH_VALUE.has(name)) break;
        }
      }
      if (name === "region") {
        if (!values[0]) throw new UsageError("argument --region: expected one argument");
        region = values[0];
      } else if (name === "query" || name === "output") {
        if (!values[0]) throw new UsageError(`argument --${name}: expected one argument`);
        if (name === "query") query = values[0];
        else if (!["json", "text", "table", "yaml", "yaml-stream"].includes(values[0])) {
          throw new UsageError(`argument --output: Invalid choice, valid choices are:\n\njson | text | table | yaml | yaml-stream`);
        } else output = values[0];
      } else if (!GLOBAL_WITH_VALUE.has(name)) {
        options.set(name, [...(options.get(name) ?? []), ...values]);
      }
      continue;
    }
    positionals.push(t);
    i++;
  }

  const [service, operation, ...rest] = positionals;
  if (!service) throw new UsageError("the following arguments are required: command");
  if (!operation) throw new UsageError(`the following arguments are required: operation (try 'aws ${service} help')`);
  return { service, operation, positionals: rest, options, region, query, output };
}

/**
 * Parses AWS CLI shorthand such as `Status=Enabled` or `Name=vpc-id,Values=vpc-1,vpc-2`
 * into a flat object. Values after the first key that has no `=` are appended to it.
 */
export function parseShorthand(text: string): Record<string, string | string[]> {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new UsageError(`invalid JSON: ${text}`);
    }
  }
  const out: Record<string, string | string[]> = {};
  let lastKey: string | null = null;
  for (const part of trimmed.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      if (!lastKey) throw new UsageError(`expected key=value, got '${part}'`);
      const prev = out[lastKey];
      out[lastKey] = Array.isArray(prev) ? [...prev, part] : [prev, part];
      continue;
    }
    lastKey = part.slice(0, eq).trim();
    out[lastKey] = part.slice(eq + 1).trim();
  }
  return out;
}
