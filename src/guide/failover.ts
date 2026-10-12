import type { Engine } from "@/engine/engine";
import { healthCheckStatus, type ZoneRequest } from "@/engine/route53/dns";
import { recordConfig, recordValues } from "@/engine/services/route53";
import type { Resource } from "@/engine/types";
import { TUTORIAL_DOMAIN } from "./dns";

/** The name the failover tutorial serves, under the zone. */
export const FAILOVER_NAME = "app";
/** The standby server's name. */
export const STANDBY = "standby";

/** What the DNS failover tutorial looks at. */
export interface FailoverState {
  zone?: Resource;
  /** app.<zone>, the name both records share. */
  host: string;
  /** The server that normally answers: not the standby, preferring one with an Elastic IP. */
  primary?: Resource;
  standby?: Resource;
  /** A health check aimed at the primary's address, and whether it passes now. */
  healthCheck?: Resource;
  healthy: boolean;
  primaryRecord?: Resource;
  secondaryRecord?: Resource;
  /** Requests to `host`, newest first. */
  requests: ZoneRequest[];
}

export async function loadFailover(engine: Engine, accountId: string, region: string, vpcId: string | undefined): Promise<FailoverState> {
  const global = (type: string) => engine.list(accountId, { service: "route53", type, region: "global" });
  const [zones, records, checks, instances] = await Promise.all([
    global("hosted-zone"),
    global("record-set"),
    global("health-check"),
    engine.list(accountId, { service: "compute", type: "instance", region }),
  ]);
  const zone = zones.find((z) => z.name === TUTORIAL_DOMAIN) ?? zones[0];
  const host = `${FAILOVER_NAME}.${zone?.name ?? TUTORIAL_DOMAIN}`;
  const live = instances.filter((i) => i.state !== "terminated" && (!vpcId || i.attributes.vpcId === vpcId));
  const standby = live.find((i) => i.name === STANDBY);
  const others = live.filter((i) => i !== standby);
  const www = zone ? records.find((r) => r.config.zoneId === zone.id && r.name === `www.${zone.name}` && r.config.type === "A") : undefined;
  const primary =
    others.find((i) => i.attributes.elasticIp) ?? others.find((i) => www && recordValues(www).includes(String(i.attributes.publicIp))) ?? others[others.length - 1];
  const ip = primary?.attributes.publicIp as string | undefined;
  const healthCheck = ip ? checks.find((h) => h.config.ipAddress === ip) : undefined;
  const healthy = healthCheck ? (await healthCheckStatus(engine, accountId, healthCheck)).healthy : false;
  const named = zone ? records.filter((r) => r.config.zoneId === zone.id && r.name === host && r.config.type === "A" && recordConfig(r).routingPolicy === "failover") : [];
  const requests = ((zone?.attributes.recentRequests as ZoneRequest[] | undefined) ?? []).filter((q) => q.host === host);
  return {
    zone,
    host,
    primary,
    standby,
    healthCheck,
    healthy,
    primaryRecord: named.find((r) => recordConfig(r).failover === "PRIMARY"),
    secondaryRecord: named.find((r) => recordConfig(r).failover === "SECONDARY"),
    requests,
  };
}
