import type { NextRequest } from "next/server";
import { handleApiRequest } from "@/engine/apigw/handle";
import { getEngine } from "@/server/api";

/**
 * The public address of a learner's HTTP API: /apigw/<api-id>/<stage?>/<path>.
 * Anyone can call it (browser, curl, another app), like a real API Gateway URL.
 *
 * The responses are written by learners' functions and served from CloudLab's
 * own domain, so they're contained:
 * - CloudLab's own cookies are removed before the request reaches a function;
 * - a function may set cookies only for its own API's path, never CloudLab's names;
 * - every response is sandboxed (no scripts) and can't change security headers.
 */

const SANDBOX = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'";
const MAX_BODY = 256 * 1024;
const OWN_COOKIES = /^(cl_|better-auth\.|__Secure-|__Host-)/;
const BLOCKED_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "set-cookie",
  "strict-transport-security",
  "service-worker-allowed",
  "access-control-allow-credentials",
  "x-frame-options",
  "content-length",
  "transfer-encoding",
  "connection",
]);

async function serve(request: NextRequest, ctx: RouteContext<"/apigw/[apiId]/[[...path]]">) {
  const { apiId } = await ctx.params;
  const prefix = `/apigw/${apiId}`;
  const pathname = request.nextUrl.pathname;
  const path = pathname.startsWith(prefix) ? pathname.slice(prefix.length) || "/" : "/";

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (key === "cookie") {
      const theirs = value
        .split(/;\s*/)
        .filter((c) => c && !OWN_COOKIES.test(c.split("=")[0]))
        .join("; ");
      if (theirs) headers.cookie = theirs;
      return;
    }
    if (key.startsWith("x-vercel") || key === "x-cloudlab-identity" || key === "x-cloudlab-workspace") return;
    headers[key] = value;
  });

  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  if (body.length > MAX_BODY) {
    return Response.json({ message: "Request Entity Too Large" }, { status: 413, headers: { "Content-Security-Policy": SANDBOX } });
  }
  const sourceIp = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "198.51.100.1";

  const res = await handleApiRequest(getEngine(), {
    apiId,
    method: request.method,
    path,
    query: request.nextUrl.search.replace(/^\?/, ""),
    headers,
    body,
    sourceIp,
  });

  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) if (!BLOCKED_HEADERS.has(k.toLowerCase())) out.set(k, v);
  // Cookies a function sets stay on its own API's path and can't touch CloudLab's.
  for (const raw of (res.headers["set-cookie"] ?? "").split(/,\s*(?=[^;=]+=)/).filter(Boolean)) {
    const name = raw.split("=")[0].trim();
    if (OWN_COOKIES.test(name)) continue;
    const attrs = raw
      .split(";")
      .map((a) => a.trim())
      .filter((a, i) => i === 0 || !/^(domain|path)=/i.test(a));
    out.append("set-cookie", [...attrs, `Path=${prefix}`].join("; "));
  }
  out.set("Content-Security-Policy", SANDBOX);
  out.set("X-Content-Type-Options", "nosniff");
  out.set("Referrer-Policy", "no-referrer");
  if (!out.has("cache-control")) out.set("Cache-Control", "no-store");

  const payload = res.isBase64 ? Buffer.from(res.body, "base64") : res.body;
  return new Response(request.method === "HEAD" || res.status === 204 || res.status === 304 ? null : payload, { status: res.status, headers: out });
}

export const GET = serve;
export const POST = serve;
export const PUT = serve;
export const PATCH = serve;
export const DELETE = serve;
export const HEAD = serve;
export const OPTIONS = serve;
