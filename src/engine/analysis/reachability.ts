import { z } from "zod";
import { cidrContains, cidrOverlaps, parseCidr } from "../cidr";
import type { Engine } from "../engine";
import { EngineError } from "../errors";
import { systemOf, type Resource } from "../types";

/**
 * "Can someone on the internet reach this instance?" Walks the same chain
 * the real network would: instance state → public IP → subnet's route table →
 * route → internet gateway → security group rules. Each link reports pass or
 * fail with a plain explanation and, when it fails, how to fix it.
 */

export const reachabilityInput = z
  .object({
    protocol: z.enum(["tcp", "udp", "icmp"]),
    port: z.preprocess(
      (v) => (v === "" || v === null ? undefined : v),
      z.coerce.number({ error: "Port must be a number." }).int().min(0).max(65535).optional(),
    ),
    source: z.string().default("0.0.0.0/0"),
  })
  .superRefine((v, ctx) => {
    if (v.protocol !== "icmp" && v.port === undefined) {
      ctx.addIssue({ code: "custom", path: ["port"], message: "Enter a port for TCP or UDP." });
    }
    if (!parseCidr(v.source)) {
      ctx.addIssue({ code: "custom", path: ["source"], message: "Enter the source as a CIDR, e.g. 0.0.0.0/0." });
    }
  });

export type ReachabilityInput = z.infer<typeof reachabilityInput>;

export type StepStatus = "pass" | "fail" | "skip" | "info";

export interface ReachabilityStep {
  id: string;
  title: string;
  status: StepStatus;
  detail: string;
  fix?: string;
  /** Resource the step is about, so the console can link to it. */
  resource?: { id: string; service: string; type: string };
}

export interface ReachabilityResult {
  reachable: boolean;
  target: string;
  summary: string;
  steps: ReachabilityStep[];
}

const link = (r: Resource) => ({ id: r.id, service: r.service, type: r.type });

function describeTraffic(input: ReachabilityInput) {
  return input.protocol === "icmp" ? "ICMP (ping)" : `${input.protocol.toUpperCase()} port ${input.port}`;
}

interface Rule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidr?: string;
  sourceGroupId?: string;
}

function ruleAllows(rule: Rule, input: ReachabilityInput): boolean {
  if (rule.protocol !== "all" && rule.protocol !== input.protocol) return false;
  if (rule.protocol !== "all" && input.protocol !== "icmp") {
    const port = input.port ?? -1;
    if (rule.fromPort === undefined || rule.toPort === undefined) return false;
    if (port < rule.fromPort || port > rule.toPort) return false;
  }
  // Rules naming a security group only match traffic from instances in that group, never the internet.
  if (!rule.cidr) return false;
  const ruleCidr = parseCidr(rule.cidr);
  const source = parseCidr(input.source);
  return !!ruleCidr && !!source && cidrContains(ruleCidr, source);
}

export async function analyzeReachability(
  engine: Engine,
  accountId: string,
  instanceId: string,
  input: ReachabilityInput,
): Promise<ReachabilityResult> {
  const instance = await engine.get(accountId, instanceId);
  if (instance.service !== "compute" || instance.type !== "instance") {
    throw new EngineError("UnsupportedOperation", "Reachability checks are only available for instances.");
  }

  const steps: ReachabilityStep[] = [];
  const traffic = describeTraffic(input);
  const publicIp = instance.attributes.publicIp as string | null;
  const target = `${publicIp ?? "(no public IP)"}${input.protocol === "icmp" ? "" : `:${input.port}`}`;

  const subnet = await engine.get(accountId, instance.config.subnetId as string).catch(() => null);
  const vpc = subnet ? await engine.get(accountId, subnet.config.vpcId as string).catch(() => null) : null;
  const vpcBlock = vpc ? parseCidr(vpc.config.cidrBlock as string) : null;
  const source = parseCidr(input.source)!;
  if (vpcBlock && cidrOverlaps(vpcBlock, source) && source.prefix !== 0) {
    throw new EngineError(
      "InvalidParameterValue",
      `${input.source} overlaps the VPC range ${vpc!.config.cidrBlock}. This check is for traffic arriving from outside the VPC.`,
    );
  }

  // 1. The instance must be running.
  steps.push(
    instance.state === "running"
      ? { id: "state", title: "Instance is running", status: "pass", detail: `${instance.id} is running.`, resource: link(instance) }
      : {
          id: "state",
          title: "Instance is running",
          status: "fail",
          detail: `${instance.id} is ${instance.state}. Only running instances accept traffic.`,
          fix: instance.state === "stopped" ? "Start the instance." : "Wait for it to reach 'running', or launch a new one.",
          resource: link(instance),
        },
  );

  // 2. It needs a public address to be reachable from the internet.
  steps.push(
    publicIp
      ? { id: "public-ip", title: "Instance has a public IP", status: "pass", detail: `Public IPv4 address ${publicIp}.` }
      : {
          id: "public-ip",
          title: "Instance has a public IP",
          status: "fail",
          detail: "The instance only has a private address, so nothing outside the VPC can address it.",
          fix:
            instance.state === "stopped"
              ? "Start the instance: it gets a new automatic public IP, or keeps its Elastic IP if it has one."
              : "Associate an Elastic IP with the instance, or launch one with 'Auto-assign public IP' enabled.",
        },
  );

  // 3–5. Routing: subnet → route table → route → internet gateway.
  // A subnet uses the route table it's explicitly associated with, otherwise its VPC's main route table.
  const tables = subnet ? await engine.list(accountId, { service: "networking", type: "route-table", region: instance.region }) : [];
  const explicit = subnet ? tables.find((t) => ((t.config.subnetIds as string[]) ?? []).includes(subnet.id)) : undefined;
  const mainTable = subnet ? tables.find((t) => systemOf(t).main && t.config.vpcId === subnet.config.vpcId) : undefined;
  const table = explicit ?? mainTable;

  if (!subnet) {
    steps.push({ id: "route-table", title: "Subnet has a route table", status: "fail", detail: "The instance's subnet no longer exists." });
  } else if (!table) {
    steps.push({
      id: "route-table",
      title: "Subnet has a route table",
      status: "fail",
      detail: `${subnet.id} isn't associated with any route table and its VPC has no main route table, so traffic has no way out of the subnet.`,
      fix: `Create a route table in ${subnet.config.vpcId}, add a 0.0.0.0/0 route to an internet gateway, and associate ${subnet.id} with it.`,
      resource: link(subnet),
    });
  } else {
    steps.push({
      id: "route-table",
      title: "Subnet has a route table",
      status: "pass",
      detail: explicit
        ? `${subnet.id} is associated with ${table.id}.`
        : `${subnet.id} has no explicit association, so it uses the VPC's main route table ${table.id}.`,
      resource: link(table),
    });
  }

  const routes = ((table?.config.routes as { destination: string; gatewayId: string }[]) ?? [])
    .map((r) => ({ ...r, block: parseCidr(r.destination) }))
    .filter((r) => r.block && cidrContains(r.block, source))
    .sort((a, b) => b.block!.prefix - a.block!.prefix);
  const route = routes[0];

  if (!table) {
    steps.push({ id: "route", title: "Route back to the source", status: "skip", detail: "Needs a route table first." });
  } else if (!route) {
    steps.push({
      id: "route",
      title: "Route back to the source",
      status: "fail",
      detail: `${table.id}${explicit ? "" : " (the main route table)"} has no route covering ${input.source}, so responses can't leave the VPC.`,
      fix: explicit
        ? `Add a route 0.0.0.0/0 → your internet gateway to ${table.id}.`
        : `Create a route table with a 0.0.0.0/0 route to your internet gateway and associate ${subnet!.id} with it. (Adding the route to the main table also works, but makes every unassociated subnet public.)`,
      resource: link(table),
    });
  } else {
    steps.push({
      id: "route",
      title: "Route back to the source",
      status: "pass",
      detail: `Route ${route.destination} → ${route.gatewayId} in ${table.id} (most specific match).`,
      resource: link(table),
    });
  }

  if (!route) {
    steps.push({ id: "gateway", title: "Internet gateway is attached", status: "skip", detail: "Needs a matching route first." });
  } else {
    const gateway = await engine.get(accountId, route.gatewayId).catch(() => null);
    const vpcId = subnet?.config.vpcId as string;
    if (!gateway) {
      steps.push({
        id: "gateway",
        title: "Internet gateway is attached",
        status: "fail",
        detail: `The route points at ${route.gatewayId}, which no longer exists. The route is a blackhole.`,
        fix: "Create an internet gateway, attach it to the VPC and point the route at it.",
      });
    } else if (gateway.config.vpcId !== vpcId) {
      steps.push({
        id: "gateway",
        title: "Internet gateway is attached",
        status: "fail",
        detail: `${gateway.id} is not attached to ${vpcId}, so the route is a blackhole.`,
        fix: `Attach ${gateway.id} to ${vpcId}.`,
        resource: link(gateway),
      });
    } else {
      steps.push({
        id: "gateway",
        title: "Internet gateway is attached",
        status: "pass",
        detail: `${gateway.id} is attached to ${vpcId}.`,
        resource: link(gateway),
      });
    }
  }

  // 6. A security group must allow the traffic in.
  const groupIds = (instance.config.securityGroupIds as string[]) ?? [];
  const groups = (await Promise.all(groupIds.map((id) => engine.get(accountId, id).catch(() => null)))).filter(
    (g): g is Resource => g !== null,
  );
  let allowedBy: { group: Resource; rule: Rule } | undefined;
  for (const group of groups) {
    const rule = ((group.config.inboundRules as Rule[]) ?? []).find((r) => ruleAllows(r, input));
    if (rule) {
      allowedBy = { group, rule };
      break;
    }
  }
  if (allowedBy) {
    const r = allowedBy.rule;
    const ports = r.protocol === "all" || input.protocol === "icmp" ? "" : ` ${r.fromPort}–${r.toPort}`;
    steps.push({
      id: "security-group",
      title: "Security group allows the traffic",
      status: "pass",
      detail: `${allowedBy.group.id} allows ${r.protocol.toUpperCase()}${ports} from ${r.cidr}.`,
      resource: link(allowedBy.group),
    });
  } else {
    const first = groups[0];
    steps.push({
      id: "security-group",
      title: "Security group allows the traffic",
      status: "fail",
      detail: `None of ${groupIds.join(", ") || "the instance's security groups"} has an inbound rule allowing ${traffic} from ${input.source}. Inbound traffic is denied unless a rule allows it.`,
      fix: first
        ? `Add an inbound rule to ${first.id}: ${input.protocol.toUpperCase()}${input.protocol === "icmp" ? "" : ` port ${input.port}`} from ${input.source}.`
        : "Attach a security group with a matching inbound rule.",
      resource: first ? link(first) : undefined,
    });
  }

  steps.push({
    id: "return-traffic",
    title: "Return traffic",
    status: "info",
    detail:
      "Security groups are stateful, so replies to allowed inbound traffic go out automatically, whatever the outbound rules say. Network ACLs aren't simulated yet; they behave like the default (allow all).",
  });

  const failures = steps.filter((s) => s.status === "fail");
  const reachable = failures.length === 0;
  return {
    reachable,
    target,
    summary: reachable
      ? `${traffic} from ${input.source} can reach ${instance.id} at ${target}.`
      : `${traffic} from ${input.source} cannot reach ${instance.id}. ${failures.length} problem${failures.length > 1 ? "s" : ""} to fix.`,
    steps,
  };
}
