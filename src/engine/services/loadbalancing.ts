import { createHash } from "node:crypto";
import { EngineError } from "../errors";
import { accountNumber, generateId } from "../ids";
import type { FieldDef, Resource, ResourceTypeDef, ServiceDef } from "../types";

/**
 * Elastic Load Balancing (application load balancers). A load balancer takes
 * requests on its listeners and forwards them to the healthy targets of a target
 * group. Resources are identified by ARN, as in the real API.
 */

const hex16 = () => generateId("x").slice(2, 18);

const elbArn = (kind: "loadbalancer/app" | "targetgroup") => ({ name, region, accountId }: { name: string; region: string; accountId: string }) =>
  `arn:aws:elasticloadbalancing:${region}:${accountNumber(accountId)}:${kind}/${name}/${hex16()}`;

export const LB_ARN = /^arn:aws:elasticloadbalancing:[a-z0-9-]+:\d{12}:loadbalancer\/app\/[A-Za-z0-9-]{1,32}\/[0-9a-f]{16}$/;
export const TG_ARN = /^arn:aws:elasticloadbalancing:[a-z0-9-]+:\d{12}:targetgroup\/[A-Za-z0-9-]{1,32}\/[0-9a-f]{16}$/;

/** A listener's ARN, derived from its load balancer and port. */
export function listenerArn(lbArn: string, port: number): string {
  const id = createHash("sha1").update(`${lbArn}:${port}`).digest("hex").slice(0, 16);
  return `${lbArn.replace(":loadbalancer/", ":listener/")}/${id}`;
}

const nameField = (placeholder: string): FieldDef => ({
  key: "name",
  label: "Name",
  type: "string",
  required: true,
  immutable: true,
  maxLength: 32,
  pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$",
  patternMessage: "Up to 32 letters, numbers and hyphens; can't start or end with a hyphen.",
  placeholder,
});

export interface Listener {
  port: number;
  protocol: string;
  targetGroupId: string;
}

export const listenersOf = (lb: Resource) => (lb.config.listeners as Listener[] | undefined) ?? [];

// ---------- target groups ----------

const targetGroup: ResourceTypeDef = {
  service: "loadbalancing",
  type: "target-group",
  label: "Target group",
  pluralLabel: "Target groups",
  description:
    "The servers a load balancer sends traffic to, and how it checks they're healthy. Register instances here, or let an Auto Scaling group do it.",
  idPrefix: "targetgroup",
  makeId: elbArn("targetgroup"),
  idPattern: TG_ARN,
  notFoundCode: "TargetGroupNotFound",
  notFoundMessage: (id) => `Target groups '${id}' not found`,
  malformedCode: "ValidationError",
  apiNoun: "target group",
  fields: [
    nameField("web-servers"),
    {
      key: "protocol",
      label: "Protocol",
      type: "enum",
      required: true,
      immutable: true,
      default: "HTTP",
      options: [{ value: "HTTP", label: "HTTP" }],
    },
    { key: "port", label: "Port", type: "number", required: true, immutable: true, default: 80, min: 1, max: 65535, description: "The port your app listens on, on each server." },
    { key: "vpcId", label: "VPC", type: "ref", required: true, immutable: true, ref: { service: "networking", type: "vpc" } },
    { key: "healthCheckPath", label: "Health check path", type: "string", default: "/", maxLength: 1024, description: "The load balancer requests this path; a 200 means healthy." },
    {
      key: "targets",
      label: "Registered instances",
      type: "ref",
      // Terminated instances simply drop out, as they're deregistered in AWS.
      ref: { service: "compute", type: "instance", multiple: true, weak: true },
      description: "Instances that receive traffic. They must be in the target group's VPC.",
    },
  ],
  columns: [
    { label: "Port", path: "config.port" },
    { label: "Targets", path: "attributes.targetCount" },
    { label: "VPC", path: "config.vpcId", mono: true },
  ],
  iam: {
    create: "elasticloadbalancing:CreateTargetGroup",
    read: "elasticloadbalancing:DescribeTargetGroups",
    update: (changed) => (changed.includes("targets") ? ["elasticloadbalancing:RegisterTargets"] : ["elasticloadbalancing:ModifyTargetGroup"]),
    delete: "elasticloadbalancing:DeleteTargetGroup",
    arn: (r) => r.id,
  },
  dependencyError: (id) => new EngineError("ResourceInUse", `Target group '${id}' is currently in use by a listener or a rule`),
  async validate({ config, existing, ctx }) {
    if (!existing && (await ctx.list("loadbalancing", "target-group")).some((t) => t.name === config.name)) {
      throw new EngineError("DuplicateTargetGroupName", "A target group with the same name exists, but with different settings");
    }
    for (const id of (config.targets as string[]) ?? []) {
      const inst = await ctx.get(id);
      if (inst && inst.attributes.vpcId !== config.vpcId) {
        throw new EngineError("InvalidTarget", `The following targets are not in the target group VPC '${config.vpcId}': '${id}'`);
      }
    }
  },
  async derive({ config, existing, ctx }) {
    // Remember when each target was registered: health checks start as "initial".
    const before = (existing?.attributes.registeredAt as Record<string, string> | undefined) ?? {};
    const registeredAt: Record<string, string> = {};
    for (const id of (config.targets as string[]) ?? []) registeredAt[id] = before[id] ?? ctx.now().toISOString();
    return { registeredAt, targetCount: Object.keys(registeredAt).length, targetGroupName: config.name };
  },
};

// ---------- load balancers ----------

const loadBalancer: ResourceTypeDef = {
  service: "loadbalancing",
  type: "load-balancer",
  label: "Load balancer",
  pluralLabel: "Load balancers",
  description:
    "One address for your website that spreads requests across healthy servers in several availability zones. If a server fails, traffic goes to the others.",
  idPrefix: "loadbalancer",
  makeId: elbArn("loadbalancer/app"),
  idPattern: LB_ARN,
  notFoundCode: "LoadBalancerNotFound",
  notFoundMessage: (id) => `Load balancers '[${id}]' not found`,
  malformedCode: "ValidationError",
  apiNoun: "load balancer",
  fields: [
    nameField("web-lb"),
    {
      key: "scheme",
      label: "Scheme",
      type: "enum",
      required: true,
      immutable: true,
      default: "internet-facing",
      options: [
        { value: "internet-facing", label: "Internet-facing", hint: "Reachable from the internet; needs public subnets" },
        { value: "internal", label: "Internal", hint: "Only reachable inside the VPC" },
      ],
    },
    {
      key: "subnetIds",
      label: "Subnets",
      type: "ref",
      required: true,
      ref: { service: "networking", type: "subnet", multiple: true },
      description: "At least two, in different availability zones, all in one VPC. For internet-facing, use public subnets.",
    },
    {
      key: "securityGroupIds",
      label: "Security groups",
      type: "ref",
      required: true,
      ref: { service: "networking", type: "security-group", multiple: true },
      description: "Must allow the listener port (e.g. HTTP 80) from the internet.",
    },
    {
      key: "listeners",
      label: "Listeners",
      type: "list",
      maxItems: 10,
      description: "Which port the load balancer accepts traffic on, and which target group it forwards to.",
      item: [
        { key: "protocol", label: "Protocol", type: "enum", required: true, default: "HTTP", options: [{ value: "HTTP", label: "HTTP" }] },
        { key: "port", label: "Port", type: "number", required: true, min: 1, max: 65535, placeholder: "80" },
        { key: "targetGroupId", label: "Forward to", type: "ref", required: true, ref: { service: "loadbalancing", type: "target-group" } },
      ],
    },
  ],
  columns: [
    { label: "Scheme", path: "config.scheme" },
    { label: "DNS name", path: "attributes.dnsName", mono: true },
    { label: "Listeners", path: "attributes.listenerCount" },
  ],
  lifecycle: { create: { state: "provisioning", settlesTo: "active", afterMs: 6000 } },
  iam: {
    create: "elasticloadbalancing:CreateLoadBalancer",
    read: "elasticloadbalancing:DescribeLoadBalancers",
    update: (changed) => [
      ...(changed.includes("listeners") ? ["elasticloadbalancing:CreateListener"] : []),
      ...(changed.includes("subnetIds") ? ["elasticloadbalancing:SetSubnets"] : []),
      ...(changed.includes("securityGroupIds") ? ["elasticloadbalancing:SetSecurityGroups"] : []),
    ],
    delete: "elasticloadbalancing:DeleteLoadBalancer",
    arn: (r) => r.id,
  },
  async validate({ config, existing, ctx }) {
    if (!existing && (await ctx.list("loadbalancing", "load-balancer")).some((l) => l.name === config.name)) {
      throw new EngineError("DuplicateLoadBalancerName", "A load balancer with the same name already exists");
    }
    const subnets = (await Promise.all(((config.subnetIds as string[]) ?? []).map((id) => ctx.get(id)))).filter((s): s is Resource => !!s);
    const vpcs = new Set(subnets.map((s) => s.config.vpcId));
    if (vpcs.size > 1) throw new EngineError("InvalidConfigurationRequest", "The subnets must all be in the same VPC");
    const zones = new Set(subnets.map((s) => s.config.availabilityZone));
    if (zones.size < 2) {
      throw new EngineError("ValidationError", "At least two subnets in two different Availability Zones must be specified");
    }
    if (zones.size < subnets.length) {
      throw new EngineError("InvalidConfigurationRequest", "A load balancer cannot be attached to multiple subnets in the same Availability Zone");
    }
    const vpcId = [...vpcs][0] as string;
    if (config.scheme === "internet-facing" && !(await ctx.list("networking", "internet-gateway")).some((g) => g.config.vpcId === vpcId)) {
      throw new EngineError("InvalidSubnet", `VPC ${vpcId} has no internet gateway`);
    }
    for (const sgId of (config.securityGroupIds as string[]) ?? []) {
      const sg = await ctx.get(sgId);
      if (sg && sg.config.vpcId !== vpcId) throw new EngineError("InvalidSecurityGroup", `Security group '${sgId}' does not belong to VPC '${vpcId}'`);
    }
    const ports = new Set<number>();
    for (const l of (config.listeners as Listener[]) ?? []) {
      if (ports.has(Number(l.port))) throw new EngineError("DuplicateListener", "A listener already exists on this port for this load balancer");
      ports.add(Number(l.port));
      const tg = await ctx.get(l.targetGroupId);
      if (tg && tg.config.vpcId !== vpcId) {
        throw new EngineError("InvalidConfigurationRequest", `The target group '${tg.id}' is not in the same VPC as the load balancer`);
      }
    }
  },
  async derive({ id, config, existing, ctx }) {
    const subnets = (await Promise.all(((config.subnetIds as string[]) ?? []).map((s) => ctx.get(s)))).filter((s): s is Resource => !!s);
    const suffix = id.split("/").pop()!.slice(0, 10);
    return {
      dnsName:
        (existing?.attributes.dnsName as string | undefined) ??
        `${config.scheme === "internal" ? "internal-" : ""}${config.name}-${parseInt(suffix, 16) % 1_000_000_000}.${ctx.region}.elb.cloudlab.local`,
      vpcId: subnets[0]?.config.vpcId ?? null,
      availabilityZones: subnets.map((s) => s.config.availabilityZone),
      listenerCount: ((config.listeners as unknown[]) ?? []).length,
      loadBalancerName: config.name,
    };
  },
};

export const loadBalancingService: ServiceDef = {
  id: "loadbalancing",
  label: "Load Balancing",
  modelledOn: "ELB",
  description: "Load balancers and target groups that spread traffic across healthy servers.",
  category: "Networking",
  types: [loadBalancer, targetGroup],
};
