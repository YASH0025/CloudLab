import { z } from "zod";
import { executeCli } from "@/cli/execute";
import { DEFAULT_REGION, EngineError } from "@/engine";
import { getCaller, getEngine, handle } from "@/server/api";

const body = z.object({
  command: z.string().max(4000, "Command is too long."),
  region: z.string().default(DEFAULT_REGION),
  /** Local files picked in the terminal for the command (name as typed → base64), at most ~1 MB. */
  files: z.record(z.string(), z.string().max(1_500_000, "File is too large.")).optional(),
});

/** Runs one CLI command line against the caller's simulated account. */
export async function POST(request: Request) {
  return handle(async () => {
    const { command, region, files } = body.parse(await request.json());
    let caller;
    try {
      caller = await getCaller();
    } catch (e) {
      // e.g. acting as a user that was deleted: the CLI reports the credentials as invalid.
      if (e instanceof EngineError) {
        return Response.json({ output: `\nAn error occurred (${e.code}): ${e.message}`, exitCode: 254, changed: false });
      }
      throw e;
    }
    const result = await executeCli(command, { engine: getEngine(), accountId: caller.accountId, region, files, principal: caller.principal });
    return Response.json(result);
  });
}
