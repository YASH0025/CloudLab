import { z } from "zod";
import { getProgress, saveChallenge, saveTutorial } from "@/guide/progress-store";
import { getEngine, getLabAccountId, handle } from "@/server/api";

const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tutorial"), id: z.string().max(64), steps: z.number().int().min(0).max(50), total: z.number().int().min(1).max(50) }),
  z.object({
    kind: z.literal("challenge"),
    id: z.string().max(64),
    score: z.number().int().min(0).max(100),
    seconds: z.number().int().min(0).max(7 * 24 * 3600),
    hints: z.number().int().min(0).max(3),
  }),
]);

/** The learner's progress, kept with their own lab (never the challenge account). */
export async function GET() {
  return handle(async () => Response.json({ progress: await getProgress(getEngine(), await getLabAccountId()) }));
}

export async function POST(request: Request) {
  return handle(async () => {
    const input = body.parse(await request.json());
    const engine = getEngine();
    const accountId = await getLabAccountId();
    if (input.kind === "tutorial") await saveTutorial(engine, accountId, input.id, input.steps, input.total);
    else await saveChallenge(engine, accountId, input.id, { score: input.score, seconds: input.seconds, hints: input.hints });
    return Response.json({ progress: await getProgress(engine, accountId) });
  });
}
