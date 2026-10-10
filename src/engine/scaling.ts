import { targetHealth } from "./analysis/health";
import type { Engine } from "./engine";
import { EngineError } from "./errors";
import { MAX_GROUP_SIZE, TRAFFIC } from "./services/autoscaling";
import { systemOf, type Resource } from "./types";

/**
 * Auto Scaling, without background jobs: whenever a region is used, each group
 * is brought up to date. In one pass a group
 *   1. replaces unhealthy instances (stopped ones, or ones its load balancer
 *      reports unhealthy, once the grace period is over),
 *   2. applies its target-tracking policy to the simulated traffic,
 *   3. launches or terminates instances to match the desired capacity, spread
 *      across its subnets' zones, and
 *   4. keeps its target groups' registrations in step.
 * Every change is recorded as a scaling activity, as in AWS.
 */

export interface Activity {
  at: string;
  description: string;
  cause: string;
  status: "Successful" | "Failed";
}

/** Scale-in waits this long after the last change, so the group doesn't flap. */
export const SCALE_IN_COOLDOWN_MS = 20_000;

export async function reconcileScaling(engine: Engine, accountId: string, region: string, now: Date): Promise<void> {
  const groups = await engine.list(accountId, { service: "autoscaling", type: "auto-scaling-group", region });
  for (const group of groups) {
    // One pass per group at a time; the lock key changes every 10s so a crashed pass can't block it for long.
    const key = `asg:${group.id}:${Math.floor(now.getTime() / 10_000)}`;
    if (!(await engine.lock(key))) continue;
    try {
      await reconcileGroup(engine, accountId, group, now);
    } finally {
      await engine.unlock(key);
    }
  }
}

async function reconcileGroup(engine: Engine, accountId: string, group: Resource, now: Date) {
  const activities: Activity[] = [];
  const log = (description: string, cause: string, status: Activity["status"] = "Successful") =>
    activities.push({ at: now.toISOString(), description, cause, status });
  const cfg = group.config;
  const region = group.region;

  const members = async () =>
    (await engine.list(accountId, { service: "compute", type: "instance", region })).filter(
      (i) => systemOf(i).managedBy === group.id && i.state !== "terminated" && i.state !== "shutting-down",
    );
  let alive = await members();

  // 1. Health: EC2 checks always; ELB checks if chosen. New instances get a grace period.
  const grace = Number(cfg.healthCheckGracePeriod ?? 30) * 1000;
  const tgs = (
    await Promise.all(((cfg.targetGroupIds as string[]) ?? []).map((id) => engine.get(accountId, id).catch(() => null)))
  ).filter((t): t is Resource => !!t);
  const elbUnhealthy = new Set<string>();
  if (cfg.healthCheckType === "ELB") {
    for (const tg of tgs) for (const h of await targetHealth(engine, accountId, tg, now)) if (h.state === "unhealthy") elbUnhealthy.add(h.id);
  }
  for (const inst of alive) {
    const inGrace = now.getTime() - new Date(inst.createdAt).getTime() < grace;
    const stopped = inst.state === "stopped" || inst.state === "stopping";
    const failedElb = !inGrace && elbUnhealthy.has(inst.id);
    if (!stopped && !failedElb) continue;
    await engine.runAction(accountId, inst.id, "terminate");
    log(
      `Terminating EC2 instance: ${inst.id}`,
      stopped
        ? `an instance was taken out of service in response to an EC2 instance status check failure (the instance is ${inst.state}).`
        : "an instance was taken out of service in response to an ELB system health check failure.",
    );
  }
  alive = await members();

  // 2. Target tracking on average CPU, driven by the simulated traffic.
  const load = TRAFFIC[String(cfg.simulatedTraffic ?? "normal")]?.load ?? TRAFFIC.normal.load;
  const running = alive.filter((i) => i.state === "running").length;
  const averageCpu = running ? Math.min(100, Math.round(load / running)) : 0;
  let desired = Number(cfg.desiredCapacity);
  const min = Number(cfg.minSize);
  const max = Math.min(Number(cfg.maxSize), MAX_GROUP_SIZE);
  const target = cfg.targetCpu ? Number(cfg.targetCpu) : null;
  const lastScaled = group.attributes.lastScaledAt ? new Date(String(group.attributes.lastScaledAt)).getTime() : 0;
  // Only judge CPU once the instances asked for are actually running.
  if (target && running > 0 && running === alive.length && running === desired) {
    const wanted = Math.min(max, Math.max(min, Math.ceil(load / target)));
    const scaleOut = wanted > desired;
    const scaleIn = wanted < desired && now.getTime() - lastScaled >= SCALE_IN_COOLDOWN_MS;
    if (scaleOut || scaleIn) {
      log(
        `Changing desired capacity from ${desired} to ${wanted}`,
        `a target tracking scaling policy saw average CPU at ${averageCpu}% against a target of ${target}%, so the group ${scaleOut ? "scaled out" : "scaled in"}.`,
      );
      desired = wanted;
      await engine.update(accountId, group.id, { desiredCapacity: desired });
      await engine.setAttributes(accountId, group.id, { lastScaledAt: now.toISOString() });
    }
  }

  // 3. Match the desired capacity.
  if (alive.length < desired) {
    const template = (await engine.list(accountId, { service: "compute", type: "launch-template", region })).find((t) => t.name === cfg.launchTemplate);
    const subnets = (cfg.subnetIds as string[]) ?? [];
    for (let n = alive.length; n < desired; n++) {
      // Balance across zones: launch into the subnet with the fewest instances.
      const counts = subnets.map((s) => ({ s, n: alive.filter((i) => i.config.subnetId === s).length }));
      const subnetId = counts.sort((a, b) => a.n - b.n)[0]?.s;
      try {
        if (!template) throw new EngineError("ValidationError", `Launch template ${cfg.launchTemplate} does not exist.`);
        const inst = await engine.create(
          accountId,
          {
            service: "compute",
            type: "instance",
            region,
            config: {
              name: group.name,
              imageId: template.config.imageId,
              instanceType: template.config.instanceType,
              subnetId,
              securityGroupIds: template.config.securityGroupIds,
              keyName: template.config.keyName || undefined,
              iamRole: template.config.iamRole || undefined,
              associatePublicIp: template.config.associatePublicIp ?? "subnet-default",
            },
          },
          { system: { managedBy: group.id } },
        );
        alive.push(inst);
        log(
          `Launching a new EC2 instance: ${inst.id}`,
          `an instance was started in response to a difference between desired and actual capacity, increasing the capacity from ${n} to ${n + 1}.`,
        );
      } catch (e) {
        log(
          "Launching a new EC2 instance. Status Reason: " + (e instanceof EngineError ? `${e.message}` : String(e)),
          "the group couldn't launch an instance; it will try again.",
          "Failed",
        );
        break;
      }
    }
  } else if (alive.length > desired) {
    // Terminate from the zone with the most instances, oldest first, as AWS's default policy does.
    for (let n = alive.length; n > desired; n--) {
      const byZone = new Map<string, Resource[]>();
      for (const i of alive) byZone.set(String(i.attributes.availabilityZone), [...(byZone.get(String(i.attributes.availabilityZone)) ?? []), i]);
      const busiest = [...byZone.values()].sort((a, b) => b.length - a.length)[0];
      const victim = busiest.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      await engine.runAction(accountId, victim.id, "terminate");
      alive = alive.filter((i) => i.id !== victim.id);
      log(
        `Terminating EC2 instance: ${victim.id}`,
        `an instance was taken out of service in response to a difference between desired and actual capacity, shrinking the capacity from ${n} to ${n - 1}.`,
      );
    }
  }

  // 4. Keep target group registrations in step with the group's instances.
  for (const tg of tgs) {
    const current = (tg.config.targets as string[]) ?? [];
    const others = [];
    for (const id of current) {
      const i = await engine.get(accountId, id).catch(() => null);
      // Instances of this group that are gone drop out; other instances stay as the learner registered them.
      if (i && systemOf(i).managedBy === group.id && !alive.some((a) => a.id === id)) continue;
      if (i) others.push(id);
    }
    const next = [...new Set([...others, ...alive.map((a) => a.id)])];
    if (next.length !== current.length || next.some((id) => !current.includes(id))) {
      await engine.update(accountId, tg.id, { targets: next });
    }
  }

  const previous = (group.attributes.activities as Activity[] | undefined) ?? [];
  await engine.setAttributes(accountId, group.id, {
    instanceCount: alive.length,
    averageCpu,
    ...(activities.length ? { activities: [...activities.reverse(), ...previous].slice(0, 30) } : {}),
  });
}
