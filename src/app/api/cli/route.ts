import { z } from "zod";
import { executeCli } from "@/cli/execute";
import { DEFAULT_REGION } from "@/engine";
import { getAccountId, getEngine, handle } from "@/server/api";

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
    const accountId = await getAccountId();
    const result = await executeCli(command, { engine: getEngine(), accountId, region, files });
    return Response.json(result);
  });
}
