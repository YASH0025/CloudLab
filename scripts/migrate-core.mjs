// Applies the SQL migrations in ./drizzle. Each migration runs in one transaction
// together with the row that records it, so a migration is either fully applied
// and recorded, or not at all. If two deploys race, the one that loses finds the
// migration already recorded and carries on.
//
// `db` needs two functions:
//   query(text, params?)            → rows
//   transaction([{ text, params }]) → runs the statements atomically
import { readMigrationFiles } from "drizzle-orm/migrator";

const TABLE = `"drizzle"."__drizzle_migrations"`;

export async function runMigrations(db, migrationsFolder = "./drizzle", log = () => {}) {
  await db.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await db.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);

  const isRecorded = async (millis) =>
    (await db.query(`SELECT 1 FROM ${TABLE} WHERE created_at = $1`, [millis])).length > 0;

  let applied = 0;
  for (const migration of readMigrationFiles({ migrationsFolder })) {
    if (await isRecorded(migration.folderMillis)) continue;
    const statements = [
      // Deploys running at the same time take turns, one migration at a time.
      { text: `SELECT pg_advisory_xact_lock(7461352)` },
      ...migration.sql.map((text) => text.trim()).filter(Boolean).map((text) => ({ text })),
      // Record it once, even if a re-runnable migration was applied twice.
      {
        text: `INSERT INTO ${TABLE} ("hash", "created_at") SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} WHERE created_at = $2)`,
        params: [migration.hash, migration.folderMillis],
      },
    ];
    try {
      await db.transaction(statements);
      applied++;
      log(`  applied migration ${migration.folderMillis}`);
    } catch (error) {
      // Another deploy may have applied it at the same moment.
      if (await isRecorded(migration.folderMillis)) continue;
      throw error;
    }
  }
  return applied;
}
