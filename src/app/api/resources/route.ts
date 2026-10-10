import type { NextRequest } from "next/server";
import { z } from "zod";
import { toDTO } from "@/engine";
import { getAccountId, getEngine, handle } from "@/server/api";

export async function GET(request: NextRequest) {
  return handle(async () => {
    const params = request.nextUrl.searchParams;
    const accountId = await getAccountId();
    const region = params.get("region");
    if (region) await getEngine().ensureDefaults(accountId, region);
    const items = await getEngine().list(accountId, {
      service: params.get("service") ?? undefined,
      type: params.get("type") ?? undefined,
      region: params.get("region") ?? undefined,
    });
    return Response.json({ items: items.map(toDTO) });
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
    const accountId = await getAccountId();
    await getEngine().ensureDefaults(accountId, body.region);
    const item = await getEngine().create(accountId, body);
    return Response.json({ item: toDTO(item) }, { status: 201 });
  });
}
