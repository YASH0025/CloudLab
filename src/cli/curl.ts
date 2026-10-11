import type { Engine } from "@/engine/engine";
import { handleApiRequest } from "@/engine/apigw/handle";
import type { CliResult } from "./execute";

/**
 * A small `curl` for the terminal, so you can call your HTTP APIs without
 * leaving it. It reaches API Gateway addresses only
 * (https://<api-id>.execute-api.<region>.cloudlab.local/…, or CloudLab's
 * /apigw/<api-id>/… form); anything else "can't be resolved", since the
 * terminal has no internet access.
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

export async function runCurl(tokens: string[], engine: Engine): Promise<CliResult> {
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
      else if (t.startsWith("-")) return { output: `curl: option ${t}: is unknown in CloudLab's curl (supported: -X -d --json -H -i -s)`, exitCode: 2, changed: false };
      else url = t;
    } catch (e) {
      return { output: (e as Error).message, exitCode: 2, changed: false };
    }
  }
  if (!url) return { output: "curl: no URL specified!\ncurl: try 'curl --help' for more information", exitCode: 2, changed: false };

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
  } catch {
    return { output: `curl: (3) URL rejected: Malformed input to a URL function`, exitCode: 3, changed: false };
  }
  let apiId: string | undefined;
  let path = parsed.pathname;
  const host = /^([a-z0-9]{10})\.execute-api\.[a-z0-9-]+\.cloudlab\.local$/.exec(parsed.hostname);
  if (host) apiId = host[1];
  else {
    const m = /^\/apigw\/([a-z0-9]{10})(\/.*)?$/.exec(parsed.pathname);
    if (m) {
      apiId = m[1];
      path = m[2] ?? "/";
    }
  }
  if (!apiId) {
    return {
      output: `curl: (6) Could not resolve host: ${parsed.hostname}\n(CloudLab's terminal can only reach your API Gateway endpoints, like https://<api-id>.execute-api.<region>.cloudlab.local/hello)`,
      exitCode: 6,
      changed: false,
    };
  }

  const res = await handleApiRequest(engine, {
    apiId,
    method: method ?? (body ? "POST" : "GET"),
    path,
    query: parsed.search.replace(/^\?/, ""),
    headers: { host: parsed.host, ...headers },
    body,
    sourceIp: "198.51.100.23",
  });
  const text = res.isBase64 ? `[${Buffer.from(res.body, "base64").length} bytes of binary data]` : res.body;
  if (!include) return { output: text, exitCode: 0, changed: true };
  const head = [`HTTP/2 ${res.status} ${STATUS[res.status] ?? ""}`.trimEnd(), ...Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`)];
  return { output: `${head.join("\n")}\n\n${text}`, exitCode: 0, changed: true };
}
