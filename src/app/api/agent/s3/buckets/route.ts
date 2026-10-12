import { z } from "zod";
import { LOCAL_REGION } from "@/engine/catalog";
import { getEngine, getLocal, handle } from "@/server/api";

const body = z.object({ name: z.string().max(63) });

/**
 * CreateBucket through the AWS endpoint on the learner's computer (an SDK or `aws s3 mb`):
 * the bucket becomes a CloudLab bucket in My computer (local), with S3's checks and errors.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const agent = await getLocal().authenticate(request.headers.get("authorization"));
    const { name } = body.parse(await request.json());
    const bucket = await getEngine().create(agent.accountId, { service: "storage", type: "bucket", region: LOCAL_REGION, config: { name, blockPublicAccess: true } });
    return Response.json({ name: bucket.id }, { status: 201 });
  });
}
