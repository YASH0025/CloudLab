import type { NextRequest } from "next/server";
import { z } from "zod";
import { toDTO } from "@/engine";
import { getTypeDef } from "@/engine/registry";
import { accountNumber } from "@/engine/ids";
import { authorizeActions, authorizeConsole, getCaller, getEngine, handle } from "@/server/api";

export async function GET(request: NextRequest) {
  return handle(async () => {
    const params = request.nextUrl.searchParams;
    const caller = await getCaller();
    const { accountId } = caller;
    const region = params.get("region");
    const service = params.get("service") ?? undefined;
    const type = params.get("type") ?? undefined;
    // Listing one kind of resource is a Describe/List call; the dashboard's overall counts aren't checked.
    if (service && type) authorizeConsole(caller, { kind: "read" }, { service, type }, null, region ?? "us-east-1");
    if (region) await getEngine().ensureDefaults(accountId, region);
    const items = await getEngine().list(accountId, { service, type, region: region ?? undefined });
    // Global resources (IAM) belong in every region's overview too.
    const global = !type && region ? await getEngine().list(accountId, { service, region: "global" }) : [];
    // Hidden types (bucket objects) have their own endpoints.
    return Response.json({ items: [...items, ...global].filter((r) => !getTypeDef(r.service, r.type).hidden).map(toDTO) });
  });
}

const createBody = z.object({
  service: z.string().min(1),
  type: z.string().min(1),
  region: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(request: Request) {
  return handle(async () => {
    const body = createBody.parse(await request.json());
    const caller = await getCaller();
    // The new resource's ARN where it's known up front (buckets and IAM names); EC2 uses "…/*".
    const target = { id: "*", name: String(body.config.name ?? "*"), region: body.region, config: body.config };
    authorizeConsole(caller, { kind: "create" }, body, target, body.region);
    // Giving an instance a role means handing the role to EC2: that needs iam:PassRole on the role.
    if (body.type === "instance" && typeof body.config.iamRole === "string" && body.config.iamRole) {
      authorizeActions(caller, [{ action: "iam:PassRole", resource: `arn:aws:iam::${accountNumber(caller.accountId)}:role/${body.config.iamRole}` }]);
    }
    await getEngine().ensureDefaults(caller.accountId, body.region);
    const item = await getEngine().create(caller.accountId, body);
    return Response.json({ item: toDTO(item) }, { status: 201 });
  });
}
