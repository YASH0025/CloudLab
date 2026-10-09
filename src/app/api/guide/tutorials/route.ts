import { listTutorials } from "@/guide/tutorials";
import { handle } from "@/server/api";

/** The tutorial catalogue. */
export async function GET() {
  return handle(async () => Response.json({ tutorials: listTutorials() }));
}
