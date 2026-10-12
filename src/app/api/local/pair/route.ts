import { getLabAccountId, getLocal, handle } from "@/server/api";

/** Connect a computer: a new secret token for its agent, shown once. Replaces any computer connected before. */
export async function POST() {
  return handle(async () => Response.json(await getLocal().pair(await getLabAccountId()), { status: 201 }));
}

/** Disconnect the computer: its token stops working. Apps already running on it keep running there. */
export async function DELETE() {
  return handle(async () => {
    await getLocal().disconnect(await getLabAccountId());
    return new Response(null, { status: 204 });
  });
}
