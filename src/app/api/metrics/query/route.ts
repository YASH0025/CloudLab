import { z } from "zod";
import { isSimulated, STATISTICS, type Statistic } from "@/engine/telemetry/metrics";
import { accountNumber } from "@/engine/ids";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

const body = z.object({
  region: z.string(),
  /** How far back, in minutes. */
  minutes: z.number().int().min(5).max(14 * 24 * 60).default(60),
  queries: z
    .array(
      z.object({
        id: z.string().max(64),
        namespace: z.string().min(1).max(255),
        name: z.string().min(1).max(255),
        dimensions: z.array(z.object({ Name: z.string(), Value: z.string() })).max(30).default([]),
        stat: z.enum(STATISTICS as [Statistic, ...Statistic[]]).default("Average"),
        period: z.number().int().min(60).optional(),
      }),
    )
    .min(1)
    .max(20),
});

/** The console's graphs: several metric series at once, like GetMetricData. */
export async function POST(request: Request) {
  return handle(async () => {
    const input = body.parse(await request.json());
    const caller = await getCaller();
    authorizeActions(caller, [{ action: "cloudwatch:GetMetricData", resource: "*" }]);
    const engine = getEngine();
    await engine.ensureDefaults(caller.accountId, input.region);
    const now = engine.now();
    // Enough points to draw without crossing the 1,440-datapoint limit.
    const auto = Math.max(60, Math.ceil((input.minutes * 60) / 360 / 60) * 60);
    const series = await Promise.all(
      input.queries.map(async (q) => {
        const period = q.period ?? auto;
        const end = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
        const start = new Date(end.getTime() - input.minutes * 60_000);
        const points = await engine.metrics.statistics(caller.accountId, input.region, {
          namespace: q.namespace,
          name: q.name,
          dimensions: q.dimensions,
          start,
          end,
          period,
          statistics: [q.stat],
        });
        return {
          id: q.id,
          period,
          unit: points[0]?.Unit ?? null,
          simulated: isSimulated(q.namespace, q.name),
          points: points.map((p) => ({ t: Date.parse(p.Timestamp), v: p[q.stat] as number })),
        };
      }),
    );
    return Response.json({ series, from: now.getTime() - input.minutes * 60_000, to: now.getTime(), account: accountNumber(caller.accountId) });
  });
}
