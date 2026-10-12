import { nanoid } from "nanoid";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { LOCAL_REGION } from "@/engine/catalog";
import { EngineError } from "@/engine/errors";
import { accountNumber } from "@/engine/ids";
import { authorizeActions, getBridge, getCaller, getEngine, handle } from "@/server/api";

const body = z.object({ command: z.string().trim().min(1, "Type a command.").max(4000, "The command is too long.") });

/**
 * Runs a shell command on an instance in My computer (local), as root, like
 * Systems Manager Run Command. The output arrives on the instance as lastCommand.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/exec">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const { command } = body.parse(await request.json());
    const caller = await getCaller();
    const engine = getEngine();
    const instance = await engine.get(caller.accountId, id);
    if (instance.service !== "compute" || instance.type !== "instance" || instance.region !== LOCAL_REGION) {
      throw new EngineError("InvalidInstanceId", "Commands can only be run on instances in My computer (local), which really run.");
    }
    authorizeActions(caller, [{ action: "ssm:SendCommand", resource: `arn:aws:ec2:${instance.region}:${accountNumber(caller.accountId)}:instance/${instance.id}` }]);
    if (instance.state !== "running") throw new EngineError("InvalidInstanceId", `Instances [${instance.id}] not in a valid state for account ${accountNumber(caller.accountId)}`);
    const execId = nanoid(10);
    await engine.setAttributes(caller.accountId, instance.id, { lastCommand: { id: execId, command, status: "InProgress", output: "", at: engine.now().toISOString() } });
    await getBridge().exec(instance, command, execId);
    return Response.json({ commandId: execId }, { status: 202 });
  });
}
