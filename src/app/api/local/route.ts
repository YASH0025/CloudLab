import { connection } from "next/server";
import { getLabAccountId, getLocal, handle } from "@/server/api";

/** Local mode at a glance: the connected computer (if any) and the apps it runs. */
export async function GET() {
  return handle(async () => {
    await connection();
    return Response.json(await getLocal().status(await getLabAccountId()));
  });
}
