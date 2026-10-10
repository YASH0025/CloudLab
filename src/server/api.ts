import "server-only";
import { cookies, headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getLocalStore, getStore } from "@/db/store";
import { LocalService } from "@/local/service";
import { Engine, EngineError } from "@/engine";
import { authorize, consoleChecks, parseIdentity, resolvePrincipal, type Principal } from "@/engine/iam/authorize";
import { getSignedInUser } from "./auth";

const ACCOUNT_COOKIE = "cl_account";

let engine: Engine | null = null;

export function getEngine(): Engine {
  engine ??= new Engine(getStore());
  return engine;
}

let local: LocalService | null = null;

/** Local mode: the learner's own computer, driven through its agent. */
export function getLocal(): LocalService {
  local ??= new LocalService(getLocalStore());
  return local;
}

/** Lab account ID for a signed-in user. */
export const userAccountId = (userId: string) => `u_${userId}`;

/**
 * The lab account for this request. Signed-in users have their own lab; everyone
 * else gets an anonymous one kept in a cookie, so people can start practising
 * without signing up. The first time someone signs in, the anonymous lab they
 * were using moves into their account.
 */
export async function getAccountId(): Promise<string> {
  const jar = await cookies();
  const anonymous = jar.get(ACCOUNT_COOKIE)?.value;

  const user = await getSignedInUser();
  if (user) {
    const accountId = userAccountId(user.id);
    if (anonymous) {
      await getEngine().adoptLab(anonymous, accountId);
      await getLocalStore().transferAccount(anonymous, accountId);
      jar.delete(ACCOUNT_COOKIE);
    }
    return accountId;
  }

  if (anonymous) return anonymous;
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

// ---------- IAM: who is acting, and may they? ----------

/** The console and terminal send the identity being used ("root", "user/dev", "role/admin"). */
export const IDENTITY_HEADER = "x-cloudlab-identity";

export interface Caller {
  accountId: string;
  principal: Principal;
}

/** The account plus the IAM identity the learner is acting as (root unless they switched). */
export async function getCaller(): Promise<Caller> {
  const accountId = await getAccountId();
  const identity = parseIdentity((await headers()).get(IDENTITY_HEADER));
  const principal = await resolvePrincipal(getEngine(), accountId, identity);
  return { accountId, principal };
}

/** Checks a console operation on a resource type, throwing AWS's error if the identity may not. */
export function authorizeConsole(
  caller: Caller,
  op: Parameters<typeof consoleChecks>[0],
  def: { service: string; type: string },
  target: Parameters<typeof consoleChecks>[3],
  region: string,
) {
  authorize(caller.principal, consoleChecks(op, def, caller.accountId, target, region));
}

/** Checks explicit IAM actions (e.g. s3:GetObject on an object's ARN). */
export function authorizeActions(caller: Caller, checks: { action: string; resource: string }[]) {
  authorize(caller.principal, checks);
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
