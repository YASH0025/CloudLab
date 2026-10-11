import { listChallenges } from "@/guide/challenges";
import { handle } from "@/server/api";

/** The challenge catalogue. */
export async function GET() {
  return handle(async () => Response.json({ challenges: listChallenges() }));
}
