import { targetHealth, type TargetHealth } from "@/engine/analysis/health";
import type { Engine } from "@/engine/engine";
import { listenersOf } from "@/engine/services/loadbalancing";
import { systemOf, type Resource } from "@/engine/types";
import { coversPort, inboundRules, isOwn, isPublicSubnet, type Snapshot } from "./snapshot";

/** What the high-availability tutorial looks at: load balancing and Auto Scaling in the focus VPC. */
export interface HaState {
  /** Public subnets of the VPC, one per zone, sorted by zone. */
  publicSubnets: Resource[];
  lbGroup?: Resource;
  appGroup?: Resource;
  targetGroup?: Resource;
  loadBalancer?: Resource;
  template?: Resource;
  group?: Resource;
  health: TargetHealth[];
  /** Instances the Auto Scaling group runs. */
  members: Resource[];
}

const fromInternet = (g: Resource) => inboundRules(g).some((r) => r.cidr === "0.0.0.0/0" && coversPort(r, 80));

export async function loadHa(engine: Engine, accountId: string, region: string, s: Snapshot, vpc: Resource | undefined): Promise<HaState> {
  const empty: HaState = { publicSubnets: [], health: [], members: [] };
  if (!vpc) return empty;
  const list = (service: string, type: string) => engine.list(accountId, { service, type, region });
  const [tgs, lbs, templates, groups] = await Promise.all([
    list("loadbalancing", "target-group"),
    list("loadbalancing", "load-balancer"),
    list("compute", "launch-template"),
    list("autoscaling", "auto-scaling-group"),
  ]);

  const byZone = new Map<string, Resource>();
  for (const sub of s.subnets.filter((x) => x.config.vpcId === vpc.id && isPublicSubnet(s, x))) {
    const z = String(sub.config.availabilityZone);
    if (!byZone.has(z)) byZone.set(z, sub);
  }
  const publicSubnets = [...byZone.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, sub]) => sub);

  const own = s.groups.filter((g) => g.config.vpcId === vpc.id && isOwn(g));
  const lbGroup = own.find((g) => g.name === "lb" && fromInternet(g)) ?? own.find((g) => fromInternet(g) && g.name !== "web");
  const appGroup = lbGroup ? own.find((g) => inboundRules(g).some((r) => r.sourceGroupId === lbGroup.id && coversPort(r, 80))) : undefined;

  const vpcTgs = tgs.filter((t) => t.config.vpcId === vpc.id);
  const vpcLbs = lbs.filter((l) => l.attributes.vpcId === vpc.id);
  const loadBalancer = vpcLbs.find((l) => listenersOf(l).some((x) => Number(x.port) === 80 && vpcTgs.some((t) => t.id === x.targetGroupId))) ?? vpcLbs[0];
  const forwarded = loadBalancer ? listenersOf(loadBalancer).find((x) => Number(x.port) === 80)?.targetGroupId : undefined;
  const targetGroup = vpcTgs.find((t) => t.id === forwarded) ?? vpcTgs[0];

  const template = templates.find((t) => appGroup && ((t.config.securityGroupIds as string[]) ?? []).includes(appGroup.id)) ?? templates[0];
  const group = groups.find((g) => template && g.config.launchTemplate === template.name) ?? groups[0];
  const members = group ? s.instances.filter((i) => systemOf(i).managedBy === group.id) : [];
  const health = targetGroup ? await targetHealth(engine, accountId, targetGroup, engine.now()) : [];

  return { publicSubnets, lbGroup, appGroup, targetGroup, loadBalancer, template, group, health, members };
}

/** Healthy targets, and how many zones they're spread over. */
export function healthySpread(ha: HaState) {
  const healthy = ha.health.filter((h) => h.state === "healthy");
  return { count: healthy.length, zones: new Set(healthy.map((h) => h.availabilityZone)).size };
}

export const activityCauses = (g?: Resource) =>
  ((g?.attributes.activities as { cause: string }[] | undefined) ?? []).map((a) => a.cause);
