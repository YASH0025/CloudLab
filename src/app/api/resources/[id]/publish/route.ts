import type { NextRequest } from "next/server";
import { z } from "zod";
import { EngineError } from "@/engine/errors";
import { publish } from "@/engine/sns/publish";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

const body = z.object({
  message: z.string(),
  subject: z.string().optional(),
  messageStructure: z.literal("json").optional(),
  attributes: z.record(z.string(), z.object({ DataType: z.string(), StringValue: z.string().optional() })).default({}),
});

/** The console's "Publish message": sends a message to a topic and reports what happened to each copy. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/publish">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const input = body.parse(await request.json().catch(() => ({})));
    const caller = await getCaller();
    const engine = getEngine();
    const topic = await engine.get(caller.accountId, id);
    if (topic.service !== "sns" || topic.type !== "topic") throw new EngineError("ValidationError", "Only SNS topics can be published to.");
    authorizeActions(caller, [{ action: "sns:Publish", resource: topic.id }]);
    const result = await publish(engine, caller.accountId, topic, { ...input, subject: input.subject || undefined });
    return Response.json({ result });
  });
}
