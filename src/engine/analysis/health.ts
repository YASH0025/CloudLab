import { cidrContains, parseCidr } from "../cidr";
import type { Engine } from "../engine";
import { listenersOf } from "../services/loadbalancing";
import type { Resource } from "../types";

/**
 * Target health, the way a load balancer's health checks see it. The states and
 * reason codes match DescribeTargetHealth: initial, healthy, unhealthy, unused.
 */

export type TargetState = "initial" | "healthy" | "unhealthy" | "unused";

export interface TargetHealth {
  id: string;
  port: number;
  availabilityZone: string | null;
  state: TargetState;
  reason?: string;
  description?: string;
}

/** How long health checks take to pass after a target is registered. */
export const INITIAL_CHECK_MS = 10_000;

interface Rule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidr?: string;
  sourceGroupId?: string;
}

const allowsPort = (r: Rule, port: number) =>
  r.protocol === "all" || (r.protocol === "tcp" && (r.fromPort ?? -1) <= port && (r.toPort ?? -1) >= port);

/** The load balancers in the target group's region with a listener that forwards to it. */
export async function loadBalancersFor(engine: Engine, accountId: string, tg: Resource): Promise<Resource[]> {
  const lbs = await engine.list(accountId, { service: "loadbalancing", type: "load-balancer", region: tg.region });
  return lbs.filter((lb) => listenersOf(lb).some((l) => l.targetGroupId === tg.id));
}

export async function targetHealth(engine: Engine, accountId: string, tg: Resource, now: Date): Promise<TargetHealth[]> {
  const port = Number(tg.config.port);
  const lbs = await loadBalancersFor(engine, accountId, tg);
  const zones = new Set(lbs.flatMap((lb) => (lb.attributes.availabilityZones as string[]) ?? []));
  const lbGroups = new Set(lbs.flatMap((lb) => (lb.config.securityGroupIds as string[]) ?? []));
  const lbSubnets = (
    await Promise.all(lbs.flatMap((lb) => ((lb.config.subnetIds as string[]) ?? []).map((id) => engine.get(accountId, id).catch(() => null))))
  ).filter((s): s is Resource => !!s);
  const registeredAt = (tg.attributes.registeredAt as Record<string, string> | undefined) ?? {};

  const out: TargetHealth[] = [];
  for (const id of (tg.config.targets as string[]) ?? []) {
    const inst = await engine.get(accountId, id).catch(() => null);
    const base = { id, port, availabilityZone: (inst?.attributes.availabilityZone as string | undefined) ?? null };
    const say = (state: TargetState, reason?: string, description?: string) => out.push({ ...base, state, reason, description });

    if (!inst || inst.state === "terminated" || inst.state === "shutting-down") {
      say("unused", "Target.InvalidState", "Target is in the terminated state");
    } else if (inst.state === "stopped" || inst.state === "stopping") {
      say("unused", "Target.InvalidState", "Target is in the stopped state");
    } else if (lbs.length === 0) {
      say("unused", "Target.NotInUse", "Target group is not configured to receive traffic from the load balancer");
    } else if (!zones.has(String(inst.attributes.availabilityZone))) {
      say("unused", "Target.NotInUse", "Target is in an Availability Zone that is not enabled for the load balancer");
    } else if (inst.state === "pending") {
      say("initial", "Elb.RegistrationInProgress", "Target registration is in progress");
    } else if (now.getTime() - new Date(registeredAt[id] ?? 0).getTime() < INITIAL_CHECK_MS) {
      say("initial", "Elb.InitialHealthChecking", "Initial health checks in progress");
    } else if (!(await reachableFromLoadBalancer(engine, accountId, inst, port, lbGroups, lbSubnets))) {
      say("unhealthy", "Target.Timeout", "Request timed out");
    } else {
      say("healthy");
    }
  }
  return out;
}

/** The health check gets through if one of the instance's groups lets the port in from the load balancer. */
async function reachableFromLoadBalancer(
  engine: Engine,
  accountId: string,
  inst: Resource,
  port: number,
  lbGroups: Set<string>,
  lbSubnets: Resource[],
): Promise<boolean> {
  for (const sgId of (inst.config.securityGroupIds as string[]) ?? []) {
    const sg = await engine.get(accountId, sgId).catch(() => null);
    for (const r of (sg?.config.inboundRules as Rule[] | undefined) ?? []) {
      if (!allowsPort(r, port)) continue;
      if (r.sourceGroupId && lbGroups.has(r.sourceGroupId)) return true;
      const range = r.cidr ? parseCidr(r.cidr) : null;
      if (range && lbSubnets.some((s) => {
        const block = parseCidr(String(s.config.cidrBlock));
        return !!block && cidrContains(range, block);
      })) {
        return true;
      }
    }
  }
  return false;
}
