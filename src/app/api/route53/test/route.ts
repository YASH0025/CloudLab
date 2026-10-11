import { z } from "zod";
import { request, resolve } from "@/engine/route53/dns";
import { RECORD_TYPES } from "@/engine/services/route53";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

const body = z.object({
  name: z.string().min(1).max(253),
  type: z.enum(RECORD_TYPES).default("A"),
  /** Also send an HTTP request to the name, like curl. */
  http: z.boolean().default(false),
  path: z.string().max(1024).default("/"),
});

/** The console's "Test a name": what DNS answers (and how), and what a browser would get. */
export async function POST(req: Request) {
  return handle(async () => {
    const input = body.parse(await req.json());
    const caller = await getCaller();
    authorizeActions(caller, [{ action: "route53:TestDNSAnswer", resource: "*" }]);
    const engine = getEngine();
    const dns = await resolve(engine, caller.accountId, input.name, input.type);
    const out: Record<string, unknown> = {
      dns: { question: dns.question, status: dns.status, answers: dns.answers, authority: dns.authority, steps: dns.steps, zoneId: dns.zone?.id ?? null },
    };
    if (input.http && input.type === "A") {
      const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
      const res = await request(engine, caller.accountId, `http://${dns.question.name}${path}`);
      out.http =
        res.kind === "error"
          ? { ok: false, error: res.message, reason: res.reason }
          : {
              ok: true,
              status: res.status,
              statusText: res.statusText,
              servedBy: res.servedBy,
              contentType: res.headers["content-type"] ?? null,
              body: res.isBase64 ? `[${Buffer.from(res.body, "base64").length} bytes of binary data]` : res.body.slice(0, 4000),
            };
    }
    return Response.json(out);
  });
}
