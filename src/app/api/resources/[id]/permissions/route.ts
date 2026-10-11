import type { NextRequest } from "next/server";
import { z } from "zod";
import { EngineError } from "@/engine/errors";
import { addPermission, removePermission } from "@/engine/lambda/invoke";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

const addBody = z.object({
  statementId: z.string().min(1).max(100),
  principal: z.string().min(1).max(200),
  sourceArn: z.string().max(1024).optional(),
});

async function loadFunction(id: string) {
  const caller = await getCaller();
  const fn = await getEngine().get(caller.accountId, id);
  if (fn.type !== "function") throw new EngineError("ValidationError", "Only Lambda functions have a resource-based policy.");
  return { caller, fn };
}

/** Adds a statement to a function's resource-based policy (who else may invoke it). */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/permissions">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const input = addBody.parse(await request.json());
    const { caller, fn } = await loadFunction(id);
    authorizeActions(caller, [{ action: "lambda:AddPermission", resource: fn.id }]);
    const statement = await addPermission(getEngine(), caller.accountId, fn, { ...input, action: "lambda:InvokeFunction" });
    return Response.json({ statement });
  });
}

/** Removes a statement: DELETE ?statementId=… */
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/permissions">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const statementId = request.nextUrl.searchParams.get("statementId") ?? "";
    const { caller, fn } = await loadFunction(id);
    authorizeActions(caller, [{ action: "lambda:RemovePermission", resource: fn.id }]);
    await removePermission(getEngine(), caller.accountId, fn, statementId);
    return Response.json({ removed: statementId });
  });
}
