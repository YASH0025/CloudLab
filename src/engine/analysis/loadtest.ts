import { cidrContains, parseCidr } from "../cidr";
import type { Engine } from "../engine";
import { listenersOf } from "../services/loadbalancing";
import type { Resource } from "../types";
import { targetHealth, type TargetHealth } from "./health";
import { routeTo, tableFor, type ReachabilityStep } from "./reachability";

/**
 * "Send requests": what happens when someone on the internet opens the load
 * balancer's address. It walks the path a request takes (DNS → security group →
 * listener → target group → a healthy target) and then simulates a few requests,
 * answered in turn by the healthy targets, or failing the way a real ALB does:
 * 503 with no targets to send to, 504 when every target is unhealthy (the load
 * balancer "fails open" and tries them anyway), or a timeout before it.
 */

export interface SimulatedResponse {
  n: number;
  /** HTTP status, or null when the request never got an answer (timed out, refused, no DNS). */
  status: number | null;
  statusText: string;
  targetId?: string;
  availabilityZone?: string;
  ms: number;
}

export interface LoadTestResult {
  url: string;
  ok: boolean;
  summary: string;
  steps: ReachabilityStep[];
  responses: SimulatedResponse[];
  targets: TargetHealth[];
}

interface Rule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidr?: string;
}

const INTERNET = parseCidr("0.0.0.0/0")!;

export async function testLoadBalancer(engine: Engine, accountId: string, lb: Resource, options: { port?: number; count?: number } = {}): Promise<LoadTestResult> {
  const now = engine.now();
  const count = Math.min(Math.max(options.count ?? 6, 1), 20);
  const listeners = listenersOf(lb);
  const port = options.port ?? Number(listeners[0]?.port ?? 80);
  const host = String(lb.attributes.dnsName);
  const url = `http://${host}${port === 80 ? "" : `:${port}`}/`;
  const steps: ReachabilityStep[] = [];
  const lbRef = { id: lb.id, service: "loadbalancing", type: "load-balancer" };
  const never = (statusText: string, ms: number): SimulatedResponse[] =>
    Array.from({ length: count }, (_, i) => ({ n: i + 1, status: null, statusText, ms }));
  const stop = (summary: string, statusText: string, ms: number, targets: TargetHealth[] = []): LoadTestResult => ({
    url,
    ok: false,
    summary,
    steps,
    responses: never(statusText, ms),
    targets,
  });

  // 1. DNS: the name only resolves once the load balancer is active, and only publicly if it's internet-facing.
  if (lb.state !== "active") {
    steps.push({
      id: "dns",
      title: "DNS name resolves",
      status: "fail",
      detail: `The load balancer is still ${lb.state ?? "being created"}; its DNS name doesn't resolve yet.`,
      fix: "Wait a few seconds for it to become active, then try again.",
      resource: lbRef,
    });
    return stop("The address doesn't exist yet: the load balancer is still provisioning.", `curl: (6) Could not resolve host: ${host}`, 0);
  }
  if (lb.config.scheme === "internal") {
    steps.push({
      id: "dns",
      title: "Reachable from the internet",
      status: "fail",
      detail: "This is an internal load balancer: its name resolves to private addresses that only work inside the VPC.",
      fix: "That's by design for internal services. For a public website, create an internet-facing load balancer in public subnets.",
      resource: lbRef,
    });
    return stop("Internal load balancers can't be reached from the internet.", "curl: (28) Connection timed out after 10001 milliseconds", 10_001);
  }
  steps.push({ id: "dns", title: "DNS name resolves", status: "pass", detail: `${host} points at the load balancer's nodes in ${(lb.attributes.availabilityZones as string[]).join(" and ")}.` });

  // 2. The load balancer's subnets need a route to an internet gateway.
  const tables = await engine.list(accountId, { service: "networking", type: "route-table", region: lb.region });
  const subnets = (await Promise.all(((lb.config.subnetIds as string[]) ?? []).map((id) => engine.get(accountId, id).catch(() => null)))).filter(
    (s): s is Resource => !!s,
  );
  const publicSubnets = subnets.filter((s) => routeTo(tableFor(s, tables).table, "0.0.0.0/0")?.gatewayId?.startsWith("igw-"));
  if (publicSubnets.length === 0) {
    steps.push({
      id: "route",
      title: "Load balancer is in public subnets",
      status: "fail",
      detail: "None of the load balancer's subnets has a route to an internet gateway, so requests from the internet can't reach it.",
      fix: "Pick public subnets for the load balancer (their route table sends 0.0.0.0/0 to an internet gateway). Your servers can stay private.",
      resource: lbRef,
    });
    return stop("Requests can't reach the load balancer: its subnets aren't public.", "curl: (28) Connection timed out after 10001 milliseconds", 10_001);
  }
  steps.push({
    id: "route",
    title: "Load balancer is in public subnets",
    status: publicSubnets.length === subnets.length ? "pass" : "info",
    detail:
      publicSubnets.length === subnets.length
        ? "Its subnets route 0.0.0.0/0 to an internet gateway."
        : `Only ${publicSubnets.map((s) => s.id).join(", ")} is public; requests to the nodes in the other subnets would time out.`,
  });

  // 3. The load balancer's security groups must let the port in from the internet.
  const groups = (await Promise.all(((lb.config.securityGroupIds as string[]) ?? []).map((id) => engine.get(accountId, id).catch(() => null)))).filter(
    (g): g is Resource => !!g,
  );
  const open = groups.some((g) =>
    ((g.config.inboundRules as Rule[] | undefined) ?? []).some((r) => {
      const portOk = r.protocol === "all" || (r.protocol === "tcp" && (r.fromPort ?? -1) <= port && (r.toPort ?? -1) >= port);
      const range = r.cidr ? parseCidr(r.cidr) : null;
      return portOk && !!range && cidrContains(range, INTERNET);
    }),
  );
  if (!open) {
    steps.push({
      id: "sg",
      title: `Security group allows port ${port} from the internet`,
      status: "fail",
      detail: `No inbound rule on the load balancer's security groups (${groups.map((g) => g.id).join(", ") || "none"}) allows TCP ${port} from 0.0.0.0/0, so the request is silently dropped.`,
      fix: `Add an inbound rule: TCP ${port} from 0.0.0.0/0 to the load balancer's security group.`,
      resource: groups[0] ? { id: groups[0].id, service: "networking", type: "security-group" } : lbRef,
    });
    return stop(`Requests time out: the load balancer's security group doesn't allow port ${port}.`, "curl: (28) Connection timed out after 10001 milliseconds", 10_001);
  }
  steps.push({ id: "sg", title: `Security group allows port ${port} from the internet`, status: "pass", detail: `An inbound rule allows TCP ${port} from 0.0.0.0/0.` });

  // 4. A listener on that port.
  const listener = listeners.find((l) => Number(l.port) === port);
  if (!listener) {
    steps.push({
      id: "listener",
      title: `A listener on port ${port}`,
      status: "fail",
      detail: listeners.length
        ? `The load balancer listens on port ${listeners.map((l) => l.port).join(", ")}, not ${port}.`
        : "The load balancer has no listeners, so it doesn't accept any requests.",
      fix: `Add a listener: HTTP ${port}, forwarding to your target group.`,
      resource: lbRef,
    });
    return stop(`Nothing is listening on port ${port}.`, `curl: (7) Failed to connect to ${host} port ${port}: Connection refused`, 2);
  }
  const tg = await engine.get(accountId, listener.targetGroupId).catch(() => null);
  steps.push({
    id: "listener",
    title: `A listener on port ${port}`,
    status: "pass",
    detail: `HTTP ${port} forwards to the target group ${tg?.name ?? listener.targetGroupId}.`,
    resource: tg ? { id: tg.id, service: "loadbalancing", type: "target-group" } : undefined,
  });

  // 5. Healthy targets.
  const targets = tg ? await targetHealth(engine, accountId, tg, now) : [];
  const healthy = targets.filter((t) => t.state === "healthy");
  const unhealthy = targets.filter((t) => t.state === "unhealthy");
  const tgRef = tg ? { id: tg.id, service: "loadbalancing", type: "target-group" } : undefined;
  if (healthy.length === 0) {
    if (unhealthy.length > 0) {
      // Fail-open: with every target unhealthy, the load balancer sends traffic to all of them anyway.
      steps.push({
        id: "targets",
        title: "Healthy targets",
        status: "fail",
        detail: `All ${unhealthy.length} registered target(s) are failing health checks (${unhealthy[0].reason}). The load balancer tries them anyway, but they don't answer.`,
        fix: "Open the target group to see why. Usually the servers' security group doesn't allow the port from the load balancer's security group.",
        resource: tgRef,
      });
      return {
        url,
        ok: false,
        summary: "504 Gateway Timeout: the load balancer reached no working server.",
        steps,
        targets,
        responses: Array.from({ length: count }, (_, i) => {
          const t = unhealthy[i % unhealthy.length];
          return { n: i + 1, status: 504, statusText: "Gateway Time-out", targetId: t.id, availabilityZone: t.availabilityZone ?? undefined, ms: 10_000 };
        }),
      };
    }
    const why = targets.length === 0 ? "No targets are registered." : `None of the ${targets.length} target(s) is healthy yet (${targets.map((t) => t.reason).filter(Boolean)[0] ?? "no reason"}).`;
    steps.push({
      id: "targets",
      title: "Healthy targets",
      status: "fail",
      detail: why,
      fix:
        targets.length === 0
          ? "Register running instances in the target group, or attach the target group to an Auto Scaling group."
          : "New targets need a few seconds to pass their first health checks. Stopped instances never will.",
      resource: tgRef,
    });
    return {
      url,
      ok: false,
      summary: "503 Service Temporarily Unavailable: there's no healthy server to send requests to.",
      steps,
      targets,
      responses: Array.from({ length: count }, (_, i) => ({ n: i + 1, status: 503, statusText: "Service Temporarily Unavailable", ms: 2 })),
    };
  }
  steps.push({
    id: "targets",
    title: "Healthy targets",
    status: "pass",
    detail: `${healthy.length} of ${targets.length} target(s) healthy${unhealthy.length ? `; ${unhealthy.length} unhealthy one(s) get no traffic` : ""}.`,
    resource: tgRef,
  });

  // Round robin across healthy targets, continuing where the last test left off.
  const start = Number(lb.attributes.nextTarget ?? 0);
  const responses = Array.from({ length: count }, (_, i) => {
    const t = healthy[(start + i) % healthy.length];
    return { n: i + 1, status: 200, statusText: "OK", targetId: t.id, availabilityZone: t.availabilityZone ?? undefined, ms: 18 + ((start + i) * 7) % 23 };
  });
  await engine.setAttributes(accountId, lb.id, { nextTarget: (start + count) % Math.max(healthy.length, 1) });
  const zones = new Set(healthy.map((t) => t.availabilityZone));
  return {
    url,
    ok: true,
    summary: `200 OK: ${count} requests shared between ${healthy.length} server${healthy.length > 1 ? "s" : ""}${zones.size > 1 ? ` in ${zones.size} zones` : ""}.`,
    steps,
    targets,
    responses,
  };
}
