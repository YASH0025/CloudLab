import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { MemoryStore, type ResourceStore } from "@/engine/store";
import { PostgresStore } from "./postgres-store";

const globalForStore = globalThis as unknown as {
  __cloudlabStore?: ResourceStore;
  __cloudlabDb?: ReturnType<typeof drizzle>;
};

/** The Drizzle database on Neon, or null when DATABASE_URL isn't set. */
export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  globalForStore.__cloudlabDb ??= drizzle({ client: neon(url) });
  return globalForStore.__cloudlabDb;
}

/**
 * Postgres (Neon) when DATABASE_URL is set. Without it, an in-memory store is used
 * so the app runs straight after cloning; its data resets on restart.
 *
 * On Vercel a missing DATABASE_URL is an error: serverless instances don't share
 * memory, so an in-memory store would lose data between requests.
 */
export function getStore(): ResourceStore {
  if (globalForStore.__cloudlabStore) return globalForStore.__cloudlabStore;
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.VERCEL) {
      throw new Error(
        "DATABASE_URL is not set. Add your Neon connection string in Vercel → Project → Settings → Environment Variables, then redeploy.",
      );
    }
    console.warn("[cloudlab] DATABASE_URL is not set; using an in-memory store (data resets on restart).");
  }
  const db = getDb();
  globalForStore.__cloudlabStore = db ? new PostgresStore(db) : new MemoryStore();
  return globalForStore.__cloudlabStore;
}

/** Which store is in use, for the health check. */
export function storeKind(): "postgres" | "memory" {
  return process.env.DATABASE_URL ? "postgres" : "memory";
}
