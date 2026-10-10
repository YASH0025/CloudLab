import { connection } from "next/server";
import { getStore, storeKind } from "@/db/store";

/**
 * Deployment check: which store is in use and whether the database answers.
 * Open /api/health on the live site after deploying.
 */
export async function GET() {
  await connection();
  const store = storeKind();
  try {
    // A cheap read that touches the resources table.
    await getStore().getAny("health-check");
    return Response.json({ ok: true, store, database: store === "postgres" ? "connected" : "not configured" });
  } catch (error) {
    return Response.json(
      { ok: false, store, database: "error", message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
