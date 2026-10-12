import { request } from "@/engine/route53/dns";
import type { CliContext } from "./commands";
import type { CliResult } from "./execute";

/**
 * A small `curl` for the terminal. Names are looked up like on the internet
 * (your Route 53 hosted zones, plus the names AWS gives your resources), so it
 * reaches API Gateway endpoints, load balancers, S3 websites and servers'
 * public IPs, directly or through your own domain. Anything else "can't be
 * resolved", since the terminal has no internet access.
 */

const STATUS: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export async function runCurl(tokens: string[], ctx: CliContext): Promise<CliResult> {
  let method: string | undefined;
  let body = "";
  let include = false;
  let url: string | undefined;
  const headers: Record<string, string> = { "user-agent": "curl/8.7.1", accept: "*/*" };
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    const next = () => {
      const v = tokens[++i];
      if (v === undefined) throw new Error(`curl: option ${t}: requires parameter`);
      return v;
    };
    try {
      if (t === "-X" || t === "--request") method = next().toUpperCase();
      else if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--json") {
        body = next();
        if (t === "--json") headers["content-type"] = "application/json";
        else headers["content-type"] ??= "application/x-www-form-urlencoded";
      } else if (t === "-H" || t === "--header") {
        const h = next();
        const c = h.indexOf(":");
        if (c > 0) headers[h.slice(0, c).trim().toLowerCase()] = h.slice(c + 1).trim();
      } else if (t === "-i" || t === "--include" || t === "-v" || t === "--verbose") include = true;
      else if (t === "-s" || t === "--silent" || t === "-S" || t === "-L" || t === "--location" || t === "-f") continue;
      else if (t.startsWith("-")) return { output: `curl: option ${t}: is unknown in Nuvora's curl (supported: -X -d --json -H -i -s)`, exitCode: 2, changed: false };
      else url = t;
    } catch (e) {
      return { output: (e as Error).message, exitCode: 2, changed: false };
    }
  }
  if (!url) return { output: "curl: no URL specified!\ncurl: try 'curl --help' for more information", exitCode: 2, changed: false };

  // Nuvora's own form of an API's address: /apigw/<api-id>/… → the API's real name.
  const apigw = /^(?:https?:\/\/[^/]+)?\/apigw\/([a-z0-9]{10})(\/[^?]*)?(\?.*)?$/.exec(url);
  if (apigw) {
    const api = await ctx.engine.findAnywhere(apigw[1]);
    url = `https://${apigw[1]}.execute-api.${api?.region ?? ctx.region}.cloudlab.local${apigw[2] ?? "/"}${apigw[3] ?? ""}`;
  }

  const res = await request(ctx.engine, ctx.accountId, url, { method: method ?? (body ? "POST" : "GET"), headers, body });
  if (res.kind === "error") {
    const hint =
      res.exitCode === 6
        ? "\n(Nuvora's terminal has no internet: it reaches your API Gateway endpoints, load balancers, S3 websites and servers, and names in your Route 53 hosted zones.)"
        : "";
    return { output: `${res.message}${hint}`, exitCode: res.exitCode, changed: false };
  }
  const text = res.isBase64 ? `[${Buffer.from(res.body, "base64").length} bytes of binary data]` : res.body;
  if (!include) return { output: text, exitCode: 0, changed: true };
  const head = [`HTTP/${url.startsWith("https") ? "2" : "1.1"} ${res.status} ${STATUS[res.status] ?? res.statusText}`.trimEnd(), ...Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`)];
  return { output: `${head.join("\n")}\n\n${text}`, exitCode: 0, changed: true };
}
