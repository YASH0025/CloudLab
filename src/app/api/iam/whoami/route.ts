import { getCaller, handle } from "@/server/api";

/** The identity the console is acting as. Fails (like AWS) for a deleted user or a role that can't be assumed. */
export async function GET() {
  return handle(async () => {
    const { principal } = await getCaller();
    return Response.json({ identity: principal.identity, arn: principal.arn });
  });
}
