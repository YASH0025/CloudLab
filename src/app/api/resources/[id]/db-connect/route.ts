import type { NextRequest } from "next/server";
import { analyzeDbConnection } from "@/engine/analysis/dbconnect";
import { EngineError } from "@/engine/errors";
import { authorizeConsole, getCaller, getEngine, handle } from "@/server/api";

/** Checks whether an instance, or someone on the internet, can connect to a database, and explains why or why not. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/db-connect">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const caller = await getCaller();
    const engine = getEngine();
    const db = await engine.get(caller.accountId, id);
    if (db.type !== "db-instance") throw new EngineError("ValidationError", "Connection checks are only available for databases.");
    // Like Reachability Analyzer, this reads the network configuration: a Describe permission.
    authorizeConsole(caller, { kind: "read" }, db, db, db.region);
    const result = await analyzeDbConnection(engine, caller.accountId, db, await request.json().catch(() => ({})));
    return Response.json({ result });
  });
}
