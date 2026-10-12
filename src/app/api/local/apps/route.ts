import { deployInput } from "@/local/types";
import { getLabAccountId, getLocal, handle } from "@/server/api";

/** Deploy an app to the connected computer: a sample, or a public GitHub repository. */
export async function POST(request: Request) {
  return handle(async () => {
    const input = deployInput.parse(await request.json());
    return Response.json(await getLocal().deploy(await getLabAccountId(), input), { status: 201 });
  });
}
