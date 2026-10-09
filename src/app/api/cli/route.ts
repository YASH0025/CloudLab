import { z } from "zod";
import { executeCli } from "@/cli/execute";
import { DEFAULT_REGION } from "@/engine";
import { getAccountId, getEngine, handle } from "@/server/api";

const body = z.object({
  command: z.string().max(4000, "Command is too long."),
  region: z.string().default(DEFAULT_REGION),
});

/** Runs one CLI command line against the caller's simulated account. */
export async function POST(request: Request) {
  return handle(async () => {
    const { command, region } = body.parse(await request.json());
    const accountId = await getAccountId();
    const result = await executeCli(command, { engine: getEngine(), accountId, region });
    return Response.json(result);
  });
}
