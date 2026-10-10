import "server-only";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { memoryAdapter } from "better-auth/adapters/memory";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import * as schema from "@/db/schema";
import { getDb } from "@/db/store";

/**
 * Sign-in with GitHub and Google (better-auth).
 *
 * Each provider switches on only when its keys are set, so the site keeps working
 * (anonymous labs only) before any keys exist:
 *   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *   BETTER_AUTH_SECRET (required once any provider is on)
 */

export type ProviderId = "github" | "google";

export function enabledProviders(): ProviderId[] {
  const out: ProviderId[] = [];
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) out.push("github");
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) out.push("google");
  return out;
}

/** The site's public address. On Vercel it's known automatically; elsewhere set BETTER_AUTH_URL. */
function baseURL(): string | undefined {
  if (process.env.BETTER_AUTH_URL) return process.env.BETTER_AUTH_URL;
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return undefined;
}

function createAuth() {
  const db = getDb();
  const options = {
    baseURL: baseURL(),
    secret: process.env.BETTER_AUTH_SECRET,
    // Without a database (local development) sessions live in memory.
    database: db
      ? drizzleAdapter(db, { provider: "pg", schema })
      : memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    socialProviders: {
      ...(enabledProviders().includes("github") && {
        github: { clientId: process.env.GITHUB_CLIENT_ID!, clientSecret: process.env.GITHUB_CLIENT_SECRET! },
      }),
      ...(enabledProviders().includes("google") && {
        google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! },
      }),
    },
    // Signing in with GitHub and Google using the same email address leads to one account.
    account: { accountLinking: { enabled: true, trustedProviders: ["github", "google"] } },
    // Keep a short-lived copy of the session in a signed cookie to avoid a database read per request.
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    trustedOrigins: [
      ...(process.env.VERCEL_PROJECT_PRODUCTION_URL ? [`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`] : []),
      ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []),
    ],
    plugins: [nextCookies()],
  } satisfies BetterAuthOptions;
  return betterAuth(options);
}

const globalForAuth = globalThis as unknown as { __cloudlabAuth?: ReturnType<typeof createAuth> };

/** The auth instance, or null when no sign-in provider is configured. */
export function getAuth() {
  if (enabledProviders().length === 0) return null;
  globalForAuth.__cloudlabAuth ??= createAuth();
  return globalForAuth.__cloudlabAuth;
}

export interface SignedInUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

/** The signed-in user for this request, if any. */
export async function getSignedInUser(): Promise<SignedInUser | null> {
  const auth = getAuth();
  if (!auth) return null;
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}
