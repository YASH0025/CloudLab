import type { NextRequest } from "next/server";
import { logGroupArn } from "@/engine/services/logs";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

/** A log group's streams, newest first: ?region=&group= */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const q = request.nextUrl.searchParams;
    const region = q.get("region") ?? "us-east-1";
    const group = q.get("group") ?? "";
    const caller = await getCaller();
    authorizeActions(caller, [{ action: "logs:DescribeLogStreams", resource: logGroupArn(region, caller.accountId, group) }]);
    return Response.json({ streams: await getEngine().logs.streams(caller.accountId, region, group) });
  });
}
