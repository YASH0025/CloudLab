import { z } from "zod";
import { cidrContains, cidrOverlaps, parseCidr } from "../cidr";
import type { Engine } from "../engine";
import { EngineError } from "../errors";
import { systemOf, type Resource } from "../types";

/**
 * Reachability checks. Each walks the same chain the real network would and
 * reports every link as pass or fail, with a plain explanation and a fix:
 *
 * - inbound from the internet: state → public IP → route table → route →
 *   internet gateway → security group;
 * - outbound to the internet: state → route table → route → internet gateway
 *   (needs a public IP) or NAT gateway (needs its own way out) → outbound rules;
 * - from another instance in the VPC: both running → same VPC (local route) →
 *   source's outbound rules → target's inbound rules, including rules that
 *   name a security group ("chaining").
 */

export const reachabilityInput = z
  .object({
    /** inbound: traffic arriving at the instance. outbound: the instance connecting out to the internet. */
    direction: z.enum(["inbound", "outbound"]).default("inbound"),
    /** For inbound checks: "internet", or the ID of another instance in the same VPC. */
    from: z.string().default("internet"),
    protocol: z.enum(["tcp", "udp", "icmp"]),
    port: z.preprocess(
      (v) => (v === "" || v === null ? undefined : v),
      z.coerce.number({ error: "Port must be a number." }).int().min(0).max(65535).optional(),
    ),
    /** Inbound from the internet: where traffic comes from. Outbound: where it goes. */
    source: z.string().default("0.0.0.0/0"),
  })
  .superRefine((v, ctx) => {
    if (v.protocol !== "icmp" && v.port === undefined) {
      ctx.addIssue({ code: "custom", path: ["port"], message: "Enter a port for TCP or UDP." });
    }
    if (!parseCidr(v.source)) {
      ctx.addIssue({ code: "custom", path: ["source"], message: "Enter an address range as a CIDR, e.g. 0.0.0.0/0." });
    }
  });

export type ReachabilityInput = z.input<typeof reachabilityInput>;
export type Input = z.output<typeof reachabilityInput>;

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

function describeTraffic(input: Input) {
  return input.protocol === "icmp" ? "ICMP (ping)" : `${input.protocol.toUpperCase()} port ${input.port}`;
}

interface Rule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidr?: string;
  sourceGroupId?: string;
}

interface Route {
  destination: string;
  gatewayId?: string;
  natGatewayId?: string;
}

/** Whether a rule's protocol and ports cover the traffic. */
function ruleCoversTraffic(rule: Rule, input: Input): boolean {
  if (rule.protocol !== "all" && rule.protocol !== input.protocol) return false;
  if (rule.protocol !== "all" && input.protocol !== "icmp") {
    const port = input.port ?? -1;
    if (rule.fromPort === undefined || rule.toPort === undefined) return false;
    if (port < rule.fromPort || port > rule.toPort) return false;
  }
  return true;
}

/** Whether a rule's address range contains a whole CIDR (e.g. the internet, or one instance's /32). */
function ruleCoversCidr(rule: Rule, cidr: string): boolean {
  if (!rule.cidr) return false;
  const ruleCidr = parseCidr(rule.cidr);
  const target = parseCidr(cidr);
  return !!ruleCidr && !!target && cidrContains(ruleCidr, target);
}

const portText = (rule: Rule, input: Input) =>
  rule.protocol === "all" || input.protocol === "icmp" ? "" : ` ${rule.fromPort}–${rule.toPort}`;
const ruleText = (rule: Rule, input: Input) =>
  `${rule.protocol === "all" ? "all traffic" : rule.protocol.toUpperCase()}${portText(rule, input)}`;
const trafficRule = (input: Input) =>
  `${input.protocol.toUpperCase()}${input.protocol === "icmp" ? "" : ` port ${input.port}`}`;

/** Everything about an instance's network the checks need. */
async function networkOf(engine: Engine, accountId: string, instance: Resource) {
  const subnet = await engine.get(accountId, instance.config.subnetId as string).catch(() => null);
  const vpc = subnet ? await engine.get(accountId, subnet.config.vpcId as string).catch(() => null) : null;
  const tables = subnet ? await engine.list(accountId, { service: "networking", type: "route-table", region: instance.region }) : [];
  const groupIds = (instance.config.securityGroupIds as string[]) ?? [];
  const groups = (await Promise.all(groupIds.map((id) => engine.get(accountId, id).catch(() => null)))).filter(
    (g): g is Resource => g !== null,
  );
  return { subnet, vpc, tables, groupIds, groups, ...tableFor(subnet, tables) };
}

/** A subnet uses the route table it's explicitly associated with, otherwise its VPC's main route table. */
export function tableFor(subnet: Resource | null, tables: Resource[]) {
  const explicit = subnet ? tables.find((t) => ((t.config.subnetIds as string[]) ?? []).includes(subnet.id)) : undefined;
  const main = subnet ? tables.find((t) => systemOf(t).main && t.config.vpcId === subnet.config.vpcId) : undefined;
  return { explicit, table: explicit ?? main };
}

/** The most specific route in a table covering a destination. */
export function routeTo(table: Resource | undefined, destination: string) {
  const dest = parseCidr(destination)!;
  return ((table?.config.routes as Route[]) ?? [])
    .map((r) => ({ ...r, block: parseCidr(r.destination) }))
    .filter((r) => r.block && cidrContains(r.block, dest))
    .sort((a, b) => b.block!.prefix - a.block!.prefix)[0];
}

const targetOf = (r: Route) => r.gatewayId || r.natGatewayId || "";

function stateStep(instance: Resource, title = "Instance is running"): ReachabilityStep {
  return instance.state === "running"
    ? { id: "state", title, status: "pass", detail: `${instance.id} is running.`, resource: link(instance) }
    : {
        id: "state",
        title,
        status: "fail",
        detail: `${instance.id} is ${instance.state}. Only running instances send or accept traffic.`,
        fix: instance.state === "stopped" ? "Start the instance." : "Wait for it to reach 'running', or launch a new one.",
        resource: link(instance),
      };
}

function tableStep(subnet: Resource | null, table: Resource | undefined, explicit: Resource | undefined, purpose: string): ReachabilityStep {
  if (!subnet) return { id: "route-table", title: "Subnet has a route table", status: "fail", detail: "The instance's subnet no longer exists." };
  if (!table) {
    return {
      id: "route-table",
      title: "Subnet has a route table",
      status: "fail",
      detail: `${subnet.id} isn't associated with any route table and its VPC has no main route table, so traffic has no way out of the subnet.`,
      fix: `Create a route table in ${subnet.config.vpcId}, add a 0.0.0.0/0 route ${purpose}, and associate ${subnet.id} with it.`,
      resource: link(subnet),
    };
  }
  return {
    id: "route-table",
    title: "Subnet has a route table",
    status: "pass",
    detail: explicit
      ? `${subnet.id} is associated with ${table.id}.`
      : `${subnet.id} has no explicit association, so it uses the VPC's main route table ${table.id}.`,
    resource: link(table),
  };
}

function finish(steps: ReachabilityStep[], target: string, ok: string, notOk: string): ReachabilityResult {
  const failures = steps.filter((s) => s.status === "fail").length;
  return {
    reachable: failures === 0,
    target,
    summary: failures === 0 ? ok : `${notOk} ${failures} problem${failures > 1 ? "s" : ""} to fix.`,
    steps,
  };
}

async function loadInstance(engine: Engine, accountId: string, id: string): Promise<Resource> {
  const instance = await engine.get(accountId, id);
  if (instance.service !== "compute" || instance.type !== "instance") {
    throw new EngineError("UnsupportedOperation", "Reachability checks are only available for instances.");
  }
  return instance;
}

export async function analyzeReachability(
  engine: Engine,
  accountId: string,
  instanceId: string,
  rawInput: ReachabilityInput,
): Promise<ReachabilityResult> {
  const input = reachabilityInput.parse(rawInput);
  const instance = await loadInstance(engine, accountId, instanceId);
  if (input.direction === "outbound") return analyzeOutbound(engine, accountId, instance, input);
  if (input.from !== "internet") {
    if (input.from === instance.id) throw new EngineError("InvalidParameterValue", "Pick a different instance as the source.");
    return analyzeBetween(engine, accountId, await loadInstance(engine, accountId, input.from), instance, input);
  }
  return analyzeInbound(engine, accountId, instance, input);
}

// ---------- from the internet ----------

export async function analyzeInbound(engine: Engine, accountId: string, instance: Resource, input: Input): Promise<ReachabilityResult> {
  const steps: ReachabilityStep[] = [];
  const traffic = describeTraffic(input);
  const publicIp = instance.attributes.publicIp as string | null;
  const target = `${publicIp ?? "(no public IP)"}${input.protocol === "icmp" ? "" : `:${input.port}`}`;
  const { subnet, vpc, table, explicit, groupIds, groups } = await networkOf(engine, accountId, instance);

  const vpcBlock = vpc ? parseCidr(vpc.config.cidrBlock as string) : null;
  const source = parseCidr(input.source)!;
  if (vpcBlock && cidrOverlaps(vpcBlock, source) && source.prefix !== 0) {
    throw new EngineError(
      "InvalidParameterValue",
      `${input.source} overlaps the VPC range ${vpc!.config.cidrBlock}. To check traffic from inside the VPC, choose another instance as the source.`,
    );
  }

  steps.push(stateStep(instance));
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

  steps.push(tableStep(subnet, table, explicit, "to an internet gateway"));
  const route = routeTo(table, input.source);
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
      detail: `Route ${route.destination} → ${targetOf(route)} in ${table.id} (most specific match).`,
      resource: link(table),
    });
  }

  if (!route) {
    steps.push({ id: "gateway", title: "Internet gateway is attached", status: "skip", detail: "Needs a matching route first." });
  } else if (route.natGatewayId) {
    steps.push({
      id: "gateway",
      title: "Internet gateway is attached",
      status: "fail",
      detail: `The route sends traffic to NAT gateway ${route.natGatewayId}. A NAT gateway only carries connections the subnet starts; nobody on the internet can start one in. This is a private subnet.`,
      fix: "Servers the internet must reach belong in a public subnet (0.0.0.0/0 → internet gateway). Keep private servers private, and reach them through a bastion host.",
      resource: { id: route.natGatewayId, service: "networking", type: "nat-gateway" },
    });
  } else {
    steps.push(await gatewayStep(engine, accountId, route.gatewayId!, subnet?.config.vpcId as string));
  }

  let allowedBy: { group: Resource; rule: Rule } | undefined;
  for (const group of groups) {
    const rule = ((group.config.inboundRules as Rule[]) ?? []).find((r) => ruleCoversTraffic(r, input) && ruleCoversCidr(r, input.source));
    if (rule) {
      allowedBy = { group, rule };
      break;
    }
  }
  if (allowedBy) {
    steps.push({
      id: "security-group",
      title: "Security group allows the traffic",
      status: "pass",
      detail: `${allowedBy.group.id} allows ${ruleText(allowedBy.rule, input)} from ${allowedBy.rule.cidr}.`,
      resource: link(allowedBy.group),
    });
  } else {
    const first = groups[0];
    steps.push({
      id: "security-group",
      title: "Security group allows the traffic",
      status: "fail",
      detail: `None of ${groupIds.join(", ") || "the instance's security groups"} has an inbound rule allowing ${traffic} from ${input.source}. Inbound traffic is denied unless a rule allows it. (Rules that name a security group only match traffic from instances in that group.)`,
      fix: first ? `Add an inbound rule to ${first.id}: ${trafficRule(input)} from ${input.source}.` : "Attach a security group with a matching inbound rule.",
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

  return finish(
    steps,
    target,
    `${traffic} from ${input.source} can reach ${instance.id} at ${target}.`,
    `${traffic} from ${input.source} cannot reach ${instance.id}.`,
  );
}

async function gatewayStep(engine: Engine, accountId: string, gatewayId: string, vpcId: string): Promise<ReachabilityStep> {
  const gateway = await engine.get(accountId, gatewayId).catch(() => null);
  if (!gateway) {
    return {
      id: "gateway",
      title: "Internet gateway is attached",
      status: "fail",
      detail: `The route points at ${gatewayId}, which no longer exists. The route is a blackhole.`,
      fix: "Create an internet gateway, attach it to the VPC and point the route at it.",
    };
  }
  if (gateway.config.vpcId !== vpcId) {
    return {
      id: "gateway",
      title: "Internet gateway is attached",
      status: "fail",
      detail: `${gateway.id} is not attached to ${vpcId}, so the route is a blackhole.`,
      fix: `Attach ${gateway.id} to ${vpcId}.`,
      resource: link(gateway),
    };
  }
  return { id: "gateway", title: "Internet gateway is attached", status: "pass", detail: `${gateway.id} is attached to ${vpcId}.`, resource: link(gateway) };
}

// ---------- out to the internet ----------

async function analyzeOutbound(engine: Engine, accountId: string, instance: Resource, input: Input): Promise<ReachabilityResult> {
  const steps: ReachabilityStep[] = [];
  const traffic = describeTraffic(input);
  const destination = input.source;
  const { subnet, vpc, tables, table, explicit, groupIds, groups } = await networkOf(engine, accountId, instance);
  const vpcBlock = vpc ? parseCidr(vpc.config.cidrBlock as string) : null;
  const dest = parseCidr(destination)!;
  if (vpcBlock && cidrOverlaps(vpcBlock, dest) && dest.prefix !== 0) {
    throw new EngineError(
      "InvalidParameterValue",
      `${destination} overlaps the VPC range ${vpc!.config.cidrBlock}. To check traffic to another instance, run the check on that instance with this one as the source.`,
    );
  }
  const vpcId = subnet?.config.vpcId as string;

  steps.push(stateStep(instance));
  steps.push(tableStep(subnet, table, explicit, "to an internet gateway (public subnet) or a NAT gateway (private subnet)"));

  const route = routeTo(table, destination);
  if (!table) {
    steps.push({ id: "route", title: "Route to the internet", status: "skip", detail: "Needs a route table first." });
  } else if (!route) {
    steps.push({
      id: "route",
      title: "Route to the internet",
      status: "fail",
      detail: `${table.id}${explicit ? "" : " (the main route table)"} only has the local route, so traffic for ${destination} has nowhere to go.`,
      fix: `Add a route 0.0.0.0/0 to ${table.id}: to a NAT gateway if this is a private server, or to an internet gateway if it's public.`,
      resource: link(table),
    });
  } else {
    steps.push({
      id: "route",
      title: "Route to the internet",
      status: "pass",
      detail: `Route ${route.destination} → ${targetOf(route)} in ${table.id}.`,
      resource: link(table),
    });
  }

  if (!route) {
    steps.push({ id: "gateway", title: "Way out of the VPC", status: "skip", detail: "Needs a matching route first." });
  } else if (route.gatewayId) {
    const gw = await gatewayStep(engine, accountId, route.gatewayId, vpcId);
    steps.push(gw);
    const publicIp = instance.attributes.publicIp as string | null;
    steps.push(
      publicIp
        ? { id: "public-ip", title: "Instance has a public IP", status: "pass", detail: `Traffic leaves from ${publicIp}.` }
        : {
            id: "public-ip",
            title: "Instance has a public IP",
            status: "fail",
            detail:
              "An internet gateway swaps the instance's private address for its public one. This instance has no public IP, so requests can't get out and replies would have nowhere to come back to.",
            fix: "For a private server, send 0.0.0.0/0 to a NAT gateway instead. For a public one, associate an Elastic IP.",
            resource: link(instance),
          },
    );
  } else {
    const nat = await engine.get(accountId, route.natGatewayId!).catch(() => null);
    if (!nat) {
      steps.push({
        id: "nat",
        title: "NAT gateway is available",
        status: "fail",
        detail: `The route points at ${route.natGatewayId}, which no longer exists. The route is a blackhole.`,
        fix: "Create a NAT gateway in a public subnet and point the route at it.",
      });
    } else if (nat.state !== "available") {
      steps.push({
        id: "nat",
        title: "NAT gateway is available",
        status: "fail",
        detail: `${nat.id} is ${nat.state}. It carries traffic once it's available.`,
        fix: "Wait a few seconds for it to become available.",
        resource: link(nat),
      });
    } else {
      steps.push({
        id: "nat",
        title: "NAT gateway is available",
        status: "pass",
        detail: `${nat.id} is available. Traffic leaves the VPC from its address ${nat.attributes.publicIp}.`,
        resource: link(nat),
      });
      // The NAT gateway needs its own way out: its subnet must be public.
      const natSubnet = await engine.get(accountId, nat.config.subnetId as string).catch(() => null);
      const natTable = tableFor(natSubnet, tables).table;
      const natRoute = routeTo(natTable, destination);
      const gw = natRoute?.gatewayId ? await engine.get(accountId, natRoute.gatewayId).catch(() => null) : null;
      steps.push(
        gw && gw.config.vpcId === vpcId
          ? {
              id: "nat-subnet",
              title: "NAT gateway is in a public subnet",
              status: "pass",
              detail: `${nat.config.subnetId} routes ${natRoute!.destination} → ${gw.id}, so the NAT gateway can reach the internet.`,
              resource: natTable ? link(natTable) : undefined,
            }
          : {
              id: "nat-subnet",
              title: "NAT gateway is in a public subnet",
              status: "fail",
              detail: `${nat.id} is in ${nat.config.subnetId}, whose route table has no working route to an internet gateway. A NAT gateway forwards traffic to the internet gateway, so it must sit in a public subnet.${natRoute?.natGatewayId ? " (Its subnet routes to a NAT gateway, which loops.)" : ""}`,
              fix: natTable
                ? `Add 0.0.0.0/0 → your internet gateway to ${natTable.id}, or recreate the NAT gateway in a public subnet.`
                : "Recreate the NAT gateway in a public subnet.",
              resource: natTable ? link(natTable) : link(nat),
            },
      );
    }
  }

  let allowedBy: { group: Resource; rule: Rule } | undefined;
  for (const group of groups) {
    const rule = ((group.config.outboundRules as Rule[]) ?? []).find((r) => ruleCoversTraffic(r, input) && ruleCoversCidr(r, destination));
    if (rule) {
      allowedBy = { group, rule };
      break;
    }
  }
  steps.push(
    allowedBy
      ? {
          id: "security-group",
          title: "Security group allows the traffic out",
          status: "pass",
          detail: `${allowedBy.group.id} allows ${ruleText(allowedBy.rule, input)} out to ${allowedBy.rule.cidr}.`,
          resource: link(allowedBy.group),
        }
      : {
          id: "security-group",
          title: "Security group allows the traffic out",
          status: "fail",
          detail: `None of ${groupIds.join(", ") || "the instance's security groups"} has an outbound rule allowing ${traffic} to ${destination}.`,
          fix: groups[0] ? `Add an outbound rule to ${groups[0].id}: ${trafficRule(input)} to ${destination}.` : undefined,
          resource: groups[0] ? link(groups[0]) : undefined,
        },
  );
  steps.push({
    id: "return-traffic",
    title: "Return traffic",
    status: "info",
    detail: "Replies come back automatically: security groups are stateful, and the gateway remembers each connection the instance started.",
  });

  return finish(
    steps,
    `${destination} (${traffic})`,
    `${instance.id} can reach ${destination} on ${traffic}.`,
    `${instance.id} cannot reach ${destination} on ${traffic}.`,
  );
}

// ---------- from another instance ----------

export async function analyzeBetween(engine: Engine, accountId: string, source: Resource, target: Resource, input: Input): Promise<ReachabilityResult> {
  const steps: ReachabilityStep[] = [];
  const traffic = describeTraffic(input);
  const targetIp = target.attributes.privateIp as string;
  const sourceIp = source.attributes.privateIp as string;
  const targetAddr = `${targetIp}${input.protocol === "icmp" ? "" : `:${input.port}`}`;
  const src = await networkOf(engine, accountId, source);
  const dst = await networkOf(engine, accountId, target);

  steps.push({ ...stateStep(source, "Source instance is running"), id: "source-state" });
  steps.push({ ...stateStep(target, "Target instance is running"), id: "state" });

  const srcVpc = source.attributes.vpcId as string;
  const dstVpc = target.attributes.vpcId as string;
  steps.push(
    srcVpc === dstVpc
      ? {
          id: "same-vpc",
          title: "Both are in the same VPC",
          status: "pass",
          detail: `Both are in ${dstVpc}. Every route table has a local route for ${dst.vpc?.config.cidrBlock ?? "the VPC range"}, so traffic between subnets is routed automatically, public or private.`,
        }
      : {
          id: "same-vpc",
          title: "Both are in the same VPC",
          status: "fail",
          detail: `${source.id} is in ${srcVpc} and ${target.id} is in ${dstVpc}. VPCs are isolated from each other: private addresses in one can't reach the other.`,
          fix: "Launch both into the same VPC. (Connecting VPCs with peering isn't simulated yet.)",
        },
  );

  // Source's outbound rules: an address range containing the target, or the target's security group.
  const targetGroups = new Set(dst.groupIds);
  let outRule: { group: Resource; rule: Rule } | undefined;
  for (const group of src.groups) {
    const rule = ((group.config.outboundRules as Rule[]) ?? []).find(
      (r) => ruleCoversTraffic(r, input) && (ruleCoversCidr(r, `${targetIp}/32`) || (!!r.sourceGroupId && targetGroups.has(r.sourceGroupId))),
    );
    if (rule) {
      outRule = { group, rule };
      break;
    }
  }
  steps.push(
    outRule
      ? {
          id: "source-security-group",
          title: "Source's security group allows the traffic out",
          status: "pass",
          detail: `${outRule.group.id} allows ${ruleText(outRule.rule, input)} out to ${outRule.rule.cidr ?? outRule.rule.sourceGroupId}.`,
          resource: link(outRule.group),
        }
      : {
          id: "source-security-group",
          title: "Source's security group allows the traffic out",
          status: "fail",
          detail: `None of ${src.groupIds.join(", ")} has an outbound rule allowing ${traffic} to ${targetIp}.`,
          fix: src.groups[0] ? `Add an outbound rule to ${src.groups[0].id}: ${trafficRule(input)} to ${dst.vpc?.config.cidrBlock ?? `${targetIp}/32`}.` : undefined,
          resource: src.groups[0] ? link(src.groups[0]) : undefined,
        },
  );

  // Target's inbound rules: the source's security group (chaining) or an address range containing the source.
  const sourceGroups = new Set(src.groupIds);
  let inRule: { group: Resource; rule: Rule; byGroup: boolean } | undefined;
  for (const group of dst.groups) {
    for (const rule of (group.config.inboundRules as Rule[]) ?? []) {
      if (!ruleCoversTraffic(rule, input)) continue;
      if (rule.sourceGroupId && sourceGroups.has(rule.sourceGroupId)) inRule = { group, rule, byGroup: true };
      else if (ruleCoversCidr(rule, `${sourceIp}/32`)) inRule ??= { group, rule, byGroup: false };
      if (inRule?.byGroup) break;
    }
    if (inRule?.byGroup) break;
  }
  const sourceGroup = src.groups.find((g) => !systemOf(g).isDefault) ?? src.groups[0];
  steps.push(
    inRule
      ? {
          id: "security-group",
          title: "Target's security group allows the traffic in",
          status: "pass",
          detail: inRule.byGroup
            ? `${inRule.group.id} allows ${ruleText(inRule.rule, input)} from members of ${inRule.rule.sourceGroupId}, which ${source.id} belongs to. This is security group chaining: it keeps working when IP addresses change.`
            : `${inRule.group.id} allows ${ruleText(inRule.rule, input)} from ${inRule.rule.cidr}, which includes ${sourceIp}.`,
          resource: link(inRule.group),
        }
      : {
          id: "security-group",
          title: "Target's security group allows the traffic in",
          status: "fail",
          detail: `None of ${dst.groupIds.join(", ")} has an inbound rule allowing ${traffic} from ${source.id} (${sourceIp}) or from any of its security groups (${src.groupIds.join(", ")}).`,
          fix: dst.groups[0]
            ? `Add an inbound rule to ${dst.groups[0].id}: ${trafficRule(input)} from security group ${sourceGroup?.id ?? "of the source"}. Naming the group is better than an IP range.`
            : "Attach a security group with a matching inbound rule.",
          resource: dst.groups[0] ? link(dst.groups[0]) : undefined,
        },
  );

  return finish(
    steps,
    targetAddr,
    `${traffic} from ${source.id} can reach ${target.id} at ${targetAddr}.`,
    `${traffic} from ${source.id} cannot reach ${target.id}.`,
  );
}
