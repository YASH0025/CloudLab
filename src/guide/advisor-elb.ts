import { loadBalancersFor, targetHealth } from "@/engine/analysis/health";
import type { Engine } from "@/engine/engine";
import { listenersOf } from "@/engine/services/loadbalancing";
import type { Resource } from "@/engine/types";
import { coversPort, inboundRules } from "./snapshot";
import type { Suggestion } from "./types";

/**
 * Advisor rules for load balancers, target groups and Auto Scaling groups:
 * the problems learners hit most (servers that never turn healthy, groups that
 * can't launch, a load balancer nobody can reach), each with the fix.
 */
export async function loadBalancingProblems(engine: Engine, accountId: string, region: string) {
  const list = (service: string, type: string) => engine.list(accountId, { service, type, region });
  const [tgs, lbs, groups] = await Promise.all([
    list("loadbalancing", "target-group"),
    list("loadbalancing", "load-balancer"),
    list("autoscaling", "auto-scaling-group"),
  ]);
  const problems: Suggestion[] = [];
  const name = (r: Resource) => r.name || r.id;

  for (const tg of tgs) {
    const health = await targetHealth(engine, accountId, tg, engine.now());
    const timedOut = health.filter((h) => h.reason === "Target.Timeout");
    if (timedOut.length > 0 && !health.some((h) => h.state === "healthy")) {
      const lbGroups = (await loadBalancersFor(engine, accountId, tg)).flatMap((lb) => (lb.config.securityGroupIds as string[]) ?? []);
      problems.push({
        id: `tg-timeout-${tg.id}`,
        level: "intermediate",
        title: `The load balancer can't reach the servers in ${name(tg)}`,
        why: `Its health checks on port ${tg.config.port} get no answer, so every target is unhealthy and visitors get 504 errors. Nearly always, the servers' security group doesn't let the load balancer in.`,
        steps: [
          `Open one of the servers (${timedOut[0].id}) and note its security group.`,
          `Add an inbound rule to that group: TCP ${tg.config.port} with source ${lbGroups[0] ?? "the load balancer's security group"} (the group, not an IP range).`,
          "Within about 10 seconds the targets turn healthy.",
        ],
        link: { service: "loadbalancing", type: "target-group", mode: "detail", id: tg.id },
      });
    }
  }

  for (const g of groups) {
    const last = ((g.attributes.activities as { status: string; description: string }[] | undefined) ?? [])[0];
    if (last?.status === "Failed") {
      problems.push({
        id: `asg-failed-${g.id}`,
        level: "intermediate",
        title: `${name(g)} can't launch instances`,
        why: `Its last launch failed: ${last.description.replace(/^Launching a new EC2 instance\. Status Reason: /, "")}`,
        steps: ["Open the group and read the activity history.", "Usually the launch template points at something that no longer exists, or the subnet is full. Fix the template or the group's subnets."],
        link: { service: "autoscaling", type: "auto-scaling-group", mode: "detail", id: g.id },
      });
    }
  }

  for (const lb of lbs) {
    if (lb.state !== "active" || lb.config.scheme !== "internet-facing") continue;
    const ports = listenersOf(lb).map((l) => Number(l.port));
    if (ports.length === 0) {
      problems.push({
        id: `lb-no-listener-${lb.id}`,
        level: "intermediate",
        title: `${name(lb)} has no listener`,
        why: "Without a listener the load balancer doesn't accept any requests. A listener says which port to take traffic on and which target group to send it to.",
        steps: [`Open ${name(lb)} and add a listener: HTTP, port 80, forwarding to your target group.`],
        link: { service: "loadbalancing", type: "load-balancer", mode: "detail", id: lb.id },
        cli: `aws elbv2 create-listener --load-balancer-arn ${lb.id} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=<target-group-arn>`,
      });
      continue;
    }
    const sgs = (await Promise.all(((lb.config.securityGroupIds as string[]) ?? []).map((id) => engine.get(accountId, id).catch(() => null)))).filter(
      (x): x is Resource => !!x,
    );
    const closed = ports.filter((p) => !sgs.some((g) => inboundRules(g).some((r) => r.cidr === "0.0.0.0/0" && coversPort(r, p))));
    if (closed.length) {
      problems.push({
        id: `lb-closed-${lb.id}`,
        level: "intermediate",
        title: `Nobody on the internet can reach ${name(lb)}`,
        why: `It listens on port ${closed[0]}, but its security group doesn't allow that port from 0.0.0.0/0, so every request times out.`,
        steps: [`Open ${sgs[0] ? name(sgs[0]) : "the load balancer's security group"}.`, `Add an inbound rule: TCP ${closed[0]} from 0.0.0.0/0.`],
        link: sgs[0] ? { service: "networking", type: "security-group", mode: "detail", id: sgs[0].id } : undefined,
      });
    }
  }

  return { problems, hasLoadBalancer: lbs.length > 0 };
}
