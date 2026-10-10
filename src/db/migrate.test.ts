import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../scripts/migrate-core.mjs";

/** The deploy-time migration runner, on real Postgres (PGlite). */

function adapter(pg: PGlite) {
  return {
    query: async (text: string, params?: unknown[]) => (await pg.query(text, params ?? [])).rows,
    transaction: (statements: { text: string; params?: unknown[] }[]) =>
      pg.transaction(async (tx) => {
        for (const s of statements) await tx.query(s.text, s.params ?? []);
      }),
  };
}

const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
const recorded = async (pg: PGlite) =>
  (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`)).rows[0].n;
const tables = async (pg: PGlite) =>
  (await pg.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.t);

// PGlite (Postgres compiled to WebAssembly) takes a few seconds to start on a cold or busy machine.
describe("runMigrations", { timeout: 30_000 }, () => {
  it("applies everything on a fresh database and is a no-op the second time", async () => {
    const pg = new PGlite();
    expect(await runMigrations(adapter(pg))).toBe(migrations.length);
    expect(await tables(pg)).toEqual(["account", "agent_tasks", "agents", "blobs", "claims", "local_apps", "resources", "session", "user", "verification"]);
    expect(await runMigrations(adapter(pg))).toBe(0);
    expect(await recorded(pg)).toBe(migrations.length);
  });

  it("recovers a database left half-migrated by an interrupted deploy", async () => {
    const pg = new PGlite();
    // Earlier migrations applied and recorded, as on the live site.
    const db = adapter(pg);
    await db.query(`CREATE SCHEMA "drizzle"`);
    await db.query(`CREATE TABLE "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    for (const m of migrations.slice(0, 2)) {
      for (const stmt of m.sql) if (stmt.trim()) await pg.exec(stmt);
      await db.query(`INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`, [m.hash, m.folderMillis]);
    }
    // The sign-in migration stopped halfway: some tables and one foreign key exist, nothing recorded.
    const signIn = migrations[2].sql.map((s) => s.trim()).filter(Boolean);
    for (const stmt of signIn.slice(0, 5)) await pg.exec(stmt);

    // The sign-in migration and every one after it.
    expect(await runMigrations(db)).toBe(migrations.length - 2);
    expect(await tables(pg)).toEqual(["account", "agent_tasks", "agents", "blobs", "claims", "local_apps", "resources", "session", "user", "verification"]);
    expect(await recorded(pg)).toBe(migrations.length);
    // Foreign keys exist exactly once.
    const fks = await pg.query(`SELECT conname FROM pg_constraint WHERE contype = 'f' ORDER BY 1`);
    expect(fks.rows).toEqual([{ conname: "account_user_id_user_id_fk" }, { conname: "session_user_id_user_id_fk" }]);
  });

  it("lets two deploys run at once without failing", async () => {
    const pg = new PGlite();
    await Promise.all([runMigrations(adapter(pg)), runMigrations(adapter(pg))]);
    expect(await recorded(pg)).toBe(migrations.length);
    expect(await tables(pg)).toEqual(["account", "agent_tasks", "agents", "blobs", "claims", "local_apps", "resources", "session", "user", "verification"]);
    expect(await runMigrations(adapter(pg))).toBe(0);
  });

  it("rolls a failing migration back completely", async () => {
    const pg = new PGlite();
    const db = adapter(pg);
    let calls = 0;
    const failing = {
      query: db.query,
      transaction: async (statements: { text: string; params?: unknown[] }[]) => {
        // Make the first migration fail on its last statement.
        if (calls++ === 0) return db.transaction([...statements.slice(0, -1), { text: "SELECT * FROM no_such_table" }]);
        return db.transaction(statements);
      },
    };
    await expect(runMigrations(failing)).rejects.toThrow();
    expect(await tables(pg)).toEqual([]);
    expect(await runMigrations(db)).toBe(migrations.length);
  });
});
