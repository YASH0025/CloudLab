import { parseAws, tokenize } from "./parse";

/**
 * Local files a command line reads, so the terminal can ask for them before
 * sending it: `aws s3 cp index.html s3://bucket/` and
 * `aws s3api put-object ... --body index.html`. Safe to run in the browser.
 */
export function localUploads(line: string): string[] {
  try {
    const tokens = tokenize(line);
    if (tokens[0] !== "aws") return [];
    const cut = tokens.findIndex((t) => t.startsWith(">"));
    const p = parseAws(cut === -1 ? tokens : tokens.slice(0, cut));
    if (p.service === "s3" && p.operation === "cp") {
      const [src, dest] = p.positionals;
      return src && dest && src !== "-" && !src.startsWith("s3://") && dest.startsWith("s3://") ? [src] : [];
    }
    if (p.service === "s3api" && p.operation === "put-object") {
      const body = p.options.get("body")?.[0];
      return body ? [body] : [];
    }
    // Any other option given as file://… or fileb://… (a policy document, a function's zip, an event).
    return [...p.options.values()]
      .flat()
      .filter((v) => /^fileb?:\/\//.test(v))
      .map((v) => v.replace(/^fileb?:\/\//, ""));
  } catch {
    // Not parseable; the server will report the problem.
  }
  return [];
}
