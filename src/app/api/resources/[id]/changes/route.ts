import type { NextRequest } from "next/server";
import { z } from "zod";
import { previewChanges } from "@/engine/cloudformation/deploy";
import { EngineError } from "@/engine/errors";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

/** A stack's "Preview changes": what an update with this template and these parameters would do (a change set). */
const body = z.object({
  templateBody: z.string().min(1).max(51200),
  parameters: z.array(z.object({ key: z.string(), value: z.string().optional() })).default([]),
});

export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/changes">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const input = body.parse(await request.json().catch(() => ({})));
    const caller = await getCaller();
    const engine = getEngine();
    const stack = await engine.get(caller.accountId, id);
    if (stack.service !== "cloudformation" || stack.type !== "stack") throw new EngineError("ValidationError", "Only CloudFormation stacks have changes to preview.");
    authorizeActions(caller, [{ action: "cloudformation:CreateChangeSet", resource: stack.id }]);
    const changes = await previewChanges(engine, stack, input.templateBody, Object.fromEntries(input.parameters.map((p) => [p.key, p.value ?? ""])));
    return Response.json({ changes });
  });
}
