import { nanoid } from "nanoid";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Gives a new visitor their anonymous lab account as soon as they open the
 * console, before the page fires its first API calls. Without this, those
 * parallel first calls would each mint a different account and race to set
 * the cookie, and anything created in the first moment could land in a lab
 * the visitor never sees again.
 */

const ACCOUNT_COOKIE = "cl_account";
const SESSION_COOKIES = ["better-auth.session_token", "__Secure-better-auth.session_token"];

export function proxy(request: NextRequest) {
  const { cookies } = request;
  if (cookies.has(ACCOUNT_COOKIE) || SESSION_COOKIES.some((c) => cookies.has(c))) return NextResponse.next();

  const id = `acct_${nanoid(21)}`;
  // Make it visible to this request's own handlers too, then have the browser keep it.
  const headers = new Headers(request.headers);
  const existing = request.headers.get("cookie");
  headers.set("cookie", `${existing ? `${existing}; ` : ""}${ACCOUNT_COOKIE}=${id}`);
  const response = NextResponse.next({ request: { headers } });
  response.cookies.set(ACCOUNT_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}

export const config = {
  // Console pages only: API calls from the console then always carry the cookie.
  matcher: ["/console/:path*", "/console"],
};
