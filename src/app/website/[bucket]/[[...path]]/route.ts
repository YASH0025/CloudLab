import type { NextRequest } from "next/server";
import { getEngine } from "@/server/api";

/**
 * A bucket's static website, served the way S3 website endpoints serve it.
 *
 * Learners' pages are untrusted HTML on CloudLab's own domain, so they are
 * locked in a sandbox: no scripts, no forms, no access to CloudLab's cookies
 * or APIs. Plain HTML, CSS and images work.
 */
const SANDBOX = "sandbox; default-src 'self' data:; img-src 'self' data:; style-src 'self' 'unsafe-inline' data:; script-src 'none'; form-action 'none'";

export async function GET(request: NextRequest, ctx: RouteContext<"/website/[bucket]/[[...path]]">) {
  const { bucket } = await ctx.params;
  // Use the raw path: a trailing slash means "folder", as on S3.
  const prefix = `/website/${encodeURIComponent(bucket)}`;
  const raw = request.nextUrl.pathname.startsWith(prefix) ? request.nextUrl.pathname.slice(prefix.length) : "/";
  const path = decodeURIComponent(raw.replace(/^\//, ""));
  const res = await getEngine().objects.website(bucket, path);
  const headers: Record<string, string> = {
    "Content-Type": res.contentType,
    "Content-Security-Policy": SANDBOX,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
  if (res.location) headers.Location = res.location;
  return new Response(new Uint8Array(res.body), { status: res.status, headers });
}
