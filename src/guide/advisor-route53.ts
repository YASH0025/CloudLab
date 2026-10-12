import type { Engine } from "@/engine/engine";
import { healthCheckStatus } from "@/engine/route53/dns";
import { recordValues } from "@/engine/services/route53";
import type { Suggestion } from "./types";

/** CloudLab hands out public IPs from this documentation range (see services/ips.ts). */
const LAB_PUBLIC_IP = /^203\.0\.113\.\d+$/;

/**
 * Advisor rules for Route 53: a record pointing at a public IP no server has
 * any more (the classic "stopped and started the server, the site vanished"),
 * a failing health check, and an empty hosted zone.
 */
export async function dnsAdvice(engine: Engine, accountId: string) {
  const list = (type: string) => engine.list(accountId, { service: "route53", type, region: "global" });
  const [zones, records, checks, instances] = await Promise.all([
    list("hosted-zone"),
    list("record-set"),
    list("health-check"),
    engine.list(accountId, { service: "compute", type: "instance" }),
  ]);
  const problems: Suggestion[] = [];
  const suggestions: Suggestion[] = [];
  const liveIps = new Set(instances.filter((i) => i.state === "running").map((i) => String(i.attributes.publicIp)));

  for (const r of records) {
    if (r.config.type !== "A" || r.config.alias) continue;
    const stale = recordValues(r).filter((ip) => LAB_PUBLIC_IP.test(ip) && !liveIps.has(ip));
    if (stale.length === 0) continue;
    problems.push({
      id: `dns-stale-ip-${r.id}`,
      level: "intermediate",
      title: `${r.name} points at ${stale[0]}, which no running server has`,
      why: "A server's public IP changes when it's stopped and started (or replaced), but DNS records don't follow it. Anyone opening the name now times out.",
      steps: [
        `Open ${r.name}'s record and change its value to the server's current public IP.`,
        "To stop this happening again, give the server an Elastic IP (it keeps the same address), or put a load balancer in front and use an alias record.",
      ],
      link: { service: "route53", type: "record-set", mode: "detail", id: r.id },
    });
  }

  for (const hc of checks) {
    const status = await healthCheckStatus(engine, accountId, hc);
    if (status.healthy) continue;
    problems.push({
      id: `health-check-failing-${hc.id}`,
      level: "intermediate",
      title: `Health check ${hc.name || hc.id} is failing`,
      why: `${status.report}. Records using it are skipped, so failover sends people elsewhere (or nowhere, if there's no healthy alternative).`,
      steps: ["Open the health check to see its endpoint.", "Test that endpoint: is the server running, and does its security group allow the port from the internet?"],
      link: { service: "route53", type: "health-check", mode: "detail", id: hc.id },
      cli: `aws route53 get-health-check-status --health-check-id ${hc.id}`,
    });
  }

  for (const z of zones) {
    if (records.some((r) => r.config.zoneId === z.id && !["NS", "SOA"].includes(String(r.config.type)))) continue;
    suggestions.push({
      id: `dns-empty-zone-${z.id}`,
      level: "intermediate",
      title: `${z.name} has no records yet`,
      why: `A hosted zone starts with only NS and SOA records, so names like www.${z.name} don't resolve to anything.`,
      steps: [`Open ${z.name} and create an A record named www pointing at your server's public IP, or an alias to your load balancer.`],
      link: { service: "route53", type: "hosted-zone", mode: "detail", id: z.id },
    });
  }
  return { problems, suggestions, hasZone: zones.length > 0 };
}
