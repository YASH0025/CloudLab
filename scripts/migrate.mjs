// Applies database migrations from ./drizzle using Neon's HTTP driver (the same one
// the app uses). Runs automatically before every build (see the "build" script),
// and can be run locally with `npm run db:migrate`.
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  if (process.env.VERCEL) {
    console.error(
      "\n✖ DATABASE_URL is not set.\n  Add your Neon connection string in Vercel → Project → Settings → Environment Variables, then redeploy.\n",
    );
    process.exit(1);
  }
  console.log("DATABASE_URL is not set; skipping migrations (the app will use its in-memory store).");
  process.exit(0);
}

await migrate(drizzle({ client: neon(url) }), { migrationsFolder: "./drizzle" });
console.log("✓ Database migrations applied.");
