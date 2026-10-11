import type { NextRequest } from "next/server";
import { logGroupArn } from "@/engine/services/logs";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

/** Events of a log group, newest last, optionally filtered: ?region=&group=&pattern=&stream=&minutes= */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const q = request.nextUrl.searchParams;
    const region = q.get("region") ?? "us-east-1";
    const group = q.get("group") ?? "";
    const stream = q.get("stream");
    const minutes = Math.min(Number(q.get("minutes") ?? 1440), 14 * 24 * 60);
    const caller = await getCaller();
    authorizeActions(caller, [{ action: "logs:FilterLogEvents", resource: logGroupArn(region, caller.accountId, group) }]);
    const engine = getEngine();
    const events = await engine.logs.filter(caller.accountId, region, group, {
      pattern: q.get("pattern") ?? undefined,
      streams: stream ? [stream] : undefined,
      from: engine.now().getTime() - minutes * 60_000,
    });
    return Response.json({ events: events.slice(-500) });
  });
}
