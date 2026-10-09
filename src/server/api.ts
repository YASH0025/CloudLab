import "server-only";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getStore } from "@/db/store";
import { Engine, EngineError } from "@/engine";

const ACCOUNT_COOKIE = "cl_account";

let engine: Engine | null = null;

export function getEngine(): Engine {
  engine ??= new Engine(getStore());
  return engine;
}

/**
 * Each browser gets an anonymous lab account, kept in a cookie, so people can
 * start practising without signing up. Real accounts can replace this later.
 */
export async function getAccountId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(ACCOUNT_COOKIE)?.value;
  if (existing) return existing;
  const id = `acct_${nanoid(21)}`;
  jar.set(ACCOUNT_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}

export function errorResponse(error: unknown): Response {
  if (error instanceof EngineError) {
    return Response.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.status },
    );
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: { code: "ValidationError", message: error.issues[0]?.message ?? "Invalid request." } },
      { status: 400 },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: { code: "MalformedRequest", message: "Request body is not valid JSON." } }, { status: 400 });
  }
  console.error(error);
  return Response.json({ error: { code: "InternalError", message: "Something went wrong." } }, { status: 500 });
}

/** Wraps a handler so engine errors become structured JSON responses. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    // Let Next.js internal control-flow errors (e.g. prerender bail-outs) through.
    unstable_rethrow(error);
    return errorResponse(error);
  }
}
