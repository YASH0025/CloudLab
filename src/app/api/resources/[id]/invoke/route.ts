import type { NextRequest } from "next/server";
import { z } from "zod";
import { EngineError } from "@/engine/errors";
import { invokeFunction } from "@/engine/lambda/invoke";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

const body = z.object({ event: z.unknown().default({}) });

/** The console's Test button: runs the function with an event and returns the result and its logs. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/invoke">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const { event } = body.parse(await request.json().catch(() => ({})));
    const caller = await getCaller();
    const engine = getEngine();
    const fn = await engine.get(caller.accountId, id);
    if (fn.type !== "function") throw new EngineError("ValidationError", "Only Lambda functions can be invoked.");
    authorizeActions(caller, [{ action: "lambda:InvokeFunction", resource: fn.id }]);
    const result = await invokeFunction(engine, caller.accountId, fn, event, "console");
    return Response.json({ result });
  });
}
