import type { Engine } from "@/engine/engine";
import { healthCheckStatus } from "@/engine/route53/dns";
import { recordValues } from "@/engine/services/route53";
import type { Resource } from "@/engine/types";

/** The domain the DNS tutorial suggests. */
export const TUTORIAL_DOMAIN = "myshop.com";

/** What the Route 53 tutorial looks at: a zone, the www and apex records, requests and a health check. */
export interface DnsState {
  zone?: Resource;
  /** www.<zone> → the server's IP (an A record). */
  www?: Resource;
  /** <zone> itself, as an A record or alias. */
  apex?: Resource;
  /** Whether www.<zone> has been opened (curl or the console's test) and answered 200. */
  visited: boolean;
  /** A health check aimed at the server's IP. */
  healthCheck?: Resource;
  healthy: boolean;
}

export async function loadDns(engine: Engine, accountId: string, serverIp: string | undefined): Promise<DnsState> {
  const list = (type: string) => engine.list(accountId, { service: "route53", type, region: "global" });
  const [zones, records, checks] = await Promise.all([list("hosted-zone"), list("record-set"), list("health-check")]);
  const zone = zones.find((z) => z.name === TUTORIAL_DOMAIN) ?? zones[0];
  const inZone = zone ? records.filter((r) => r.config.zoneId === zone.id) : [];
  const www = inZone.find((r) => r.name === `www.${zone?.name}` && r.config.type === "A" && (!serverIp || recordValues(r).includes(serverIp) || r.config.alias === true));
  const apex = inZone.find((r) => r.name === zone?.name && r.config.type === "A");
  const recent = (zone?.attributes.recentRequests as { host: string; status: number | null }[] | undefined) ?? [];
  const healthCheck = checks.find((h) => serverIp && h.config.ipAddress === serverIp) ?? checks[0];
  const healthy = healthCheck ? (await healthCheckStatus(engine, accountId, healthCheck)).healthy : false;
  return { zone, www, apex, visited: recent.some((q) => q.host === `www.${zone?.name}` && q.status === 200), healthCheck, healthy };
}
