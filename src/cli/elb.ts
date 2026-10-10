import { createHash } from "node:crypto";
import { loadBalancersFor, targetHealth } from "@/engine/analysis/health";
import { EngineError } from "@/engine/errors";
import { accountNumber } from "@/engine/ids";
import { listenerArn, listenersOf, type Listener } from "@/engine/services/loadbalancing";
import type { Activity } from "@/engine/scaling";
import { systemOf, type Resource } from "@/engine/types";
import type { Args, CliContext, Command } from "./commands";
import { parseShorthand, UsageError } from "./parse";

/**
 * `aws elbv2`, `aws autoscaling` and the launch template commands of `aws ec2`.
 * Load balancers and target groups are addressed by ARN, Auto Scaling groups by
 * name, as in the real CLI.
 */

const cmd = (c: Command) => c;

const listOf = (ctx: CliContext, service: string, type: string) => ctx.engine.list(ctx.accountId, { service, type, region: ctx.region });
const load = (ctx: CliContext, service: string, type: string, id: string) => ctx.engine.getTyped(ctx.accountId, id, service, type, ctx.region);
const create = (ctx: CliContext, service: string, type: string, config: Record<string, unknown>) =>
  ctx.engine.create(ctx.accountId, { service, type, region: ctx.region, config });

/** A JSON value (object or array) or shorthand `a=b,c=d`, for structured options. */
function structured(value: string): unknown {
  const t = value.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      throw new UsageError(`Error parsing parameter: Invalid JSON: ${value}`);
    }
  }
  return parseShorthand(t);
}

const nums = (args: Args, name: string): number | undefined => {
  const v = args.one(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`argument --${name}: invalid int value: '${v}'`);
  return n;
};

// ---------- elbv2 output shapes ----------

const CANONICAL_ZONE = "Z35SXDOTRQ7X7K";

async function lbOut(ctx: CliContext, lb: Resource) {
  const subnets = await Promise.all(((lb.config.subnetIds as string[]) ?? []).map((id) => ctx.engine.get(ctx.accountId, id).catch(() => null)));
  return {
    LoadBalancerArn: lb.id,
    DNSName: lb.attributes.dnsName,
    CanonicalHostedZoneId: CANONICAL_ZONE,
    CreatedTime: lb.createdAt,
    LoadBalancerName: lb.name,
    Scheme: lb.config.scheme,
    VpcId: lb.attributes.vpcId,
    State: { Code: lb.state },
    Type: "application",
    AvailabilityZones: subnets.filter((s): s is Resource => !!s).map((s) => ({ ZoneName: s.config.availabilityZone, SubnetId: s.id, LoadBalancerAddresses: [] })),
    SecurityGroups: lb.config.securityGroupIds,
    IpAddressType: "ipv4",
  };
}

async function tgOut(ctx: CliContext, tg: Resource) {
  return {
    TargetGroupArn: tg.id,
    TargetGroupName: tg.name,
    Protocol: tg.config.protocol,
    Port: tg.config.port,
    VpcId: tg.config.vpcId,
    HealthCheckProtocol: "HTTP",
    HealthCheckPort: "traffic-port",
    HealthCheckEnabled: true,
    HealthCheckIntervalSeconds: 30,
    HealthCheckTimeoutSeconds: 5,
    HealthyThresholdCount: 5,
    UnhealthyThresholdCount: 2,
    HealthCheckPath: tg.config.healthCheckPath ?? "/",
    Matcher: { HttpCode: "200" },
    LoadBalancerArns: (await loadBalancersFor(ctx.engine, ctx.accountId, tg)).map((lb) => lb.id),
    TargetType: "instance",
    ProtocolVersion: "HTTP1",
    IpAddressType: "ipv4",
  };
}

const listenerOut = (lb: Resource, l: Listener) => ({
  ListenerArn: listenerArn(lb.id, Number(l.port)),
  LoadBalancerArn: lb.id,
  Port: Number(l.port),
  Protocol: l.protocol,
  DefaultActions: [
    {
      Type: "forward",
      TargetGroupArn: l.targetGroupId,
      ForwardConfig: { TargetGroups: [{ TargetGroupArn: l.targetGroupId, Weight: 1 }], TargetGroupStickinessConfig: { Enabled: false } },
    },
  ],
});

/** --targets Id=i-1 Id=i-2,Port=80 or JSON. */
function targetIds(args: Args): string[] {
  const raw = args.raw("targets");
  if (raw.length === 0) throw new UsageError("the following arguments are required: --targets");
  const out: string[] = [];
  for (const v of raw) {
    const parsed = structured(v);
    for (const t of Array.isArray(parsed) ? parsed : [parsed]) {
      const id = (t as Record<string, unknown>).Id;
      if (typeof id !== "string" || !id) throw new UsageError(`Missing required parameter in Targets: "Id"`);
      out.push(id);
    }
  }
  return out;
}

/** --default-actions Type=forward,TargetGroupArn=… (shorthand or JSON) → the target group's ARN. */
function forwardTarget(args: Args): string {
  const raw = args.raw("default-actions");
  if (raw.length === 0) throw new UsageError("the following arguments are required: --default-actions");
  const parsed = structured(raw.join(" "));
  const action = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
  if (!action || String(action.Type ?? "").toLowerCase() !== "forward") {
    throw new EngineError("ValidationError", "CloudLab supports 'forward' default actions only: Type=forward,TargetGroupArn=<arn>");
  }
  const fc = action.ForwardConfig as { TargetGroups?: { TargetGroupArn?: string }[] } | undefined;
  const arn = action.TargetGroupArn ?? fc?.TargetGroups?.[0]?.TargetGroupArn;
  if (typeof arn !== "string" || !arn) throw new EngineError("ValidationError", "A target group ARN must be specified");
  return arn;
}

/** The load balancer a listener ARN belongs to, and the listener. */
async function findListener(ctx: CliContext, arn: string): Promise<{ lb: Resource; listener: Listener }> {
  const lbArn = arn.replace(":listener/", ":loadbalancer/").replace(/\/[0-9a-f]{16}$/, "");
  if (!arn.includes(":listener/") || lbArn === arn) throw new EngineError("ValidationError", `'${arn}' is not a valid listener ARN`);
  const lb = await ctx.engine.get(ctx.accountId, lbArn).catch(() => null);
  const listener = lb && listenersOf(lb).find((l) => listenerArn(lb.id, Number(l.port)) === arn);
  if (!lb || !listener) throw new EngineError("ListenerNotFound", "One or more listeners not found");
  return { lb, listener };
}

// ---------- launch templates ----------

async function templateBy(ctx: CliContext, args: Args, required = true): Promise<Resource | undefined> {
  const id = args.one("launch-template-id");
  const name = args.one("launch-template-name");
  if (id) return load(ctx, "compute", "launch-template", id);
  if (name) {
    const found = (await listOf(ctx, "compute", "launch-template")).find((t) => t.name === name);
    if (!found) {
      throw new EngineError("InvalidLaunchTemplateName.NotFoundException", "At least one of the launch templates specified in the request does not exist.");
    }
    return found;
  }
  if (required) throw new EngineError("MissingParameter", "The request must contain the parameter launchTemplateName or launchTemplateId");
  return undefined;
}

const templateOut = (ctx: CliContext, t: Resource) => ({
  LaunchTemplateId: t.id,
  LaunchTemplateName: t.name,
  CreateTime: t.createdAt,
  CreatedBy: `arn:aws:iam::${accountNumber(ctx.accountId)}:root`,
  DefaultVersionNumber: t.attributes.defaultVersion ?? 1,
  LatestVersionNumber: t.attributes.latestVersion ?? 1,
});

const templateData = (t: Resource) => ({
  ImageId: t.config.imageId,
  InstanceType: t.config.instanceType,
  SecurityGroupIds: t.config.securityGroupIds,
  ...(t.config.keyName ? { KeyName: t.config.keyName } : {}),
  ...(t.config.iamRole ? { IamInstanceProfile: { Name: t.config.iamRole } } : {}),
  ...(t.config.userData ? { UserData: Buffer.from(String(t.config.userData)).toString("base64") } : {}),
  ...(t.config.associatePublicIp && t.config.associatePublicIp !== "subnet-default"
    ? { NetworkInterfaces: [{ DeviceIndex: 0, AssociatePublicIpAddress: t.config.associatePublicIp === "enable" }] }
    : {}),
});

/** --launch-template-data {"ImageId":…} → the template's fields. */
function templateConfig(value: string): Record<string, unknown> {
  const d = structured(value) as Record<string, unknown>;
  const ni = (d.NetworkInterfaces as { AssociatePublicIpAddress?: boolean; Groups?: string[] }[] | undefined)?.[0];
  const sgs = (d.SecurityGroupIds as string[] | undefined) ?? ni?.Groups;
  let userData: string | undefined;
  if (typeof d.UserData === "string") {
    // The API takes user data base64-encoded; accept plain text too.
    const decoded = Buffer.from(d.UserData, "base64").toString("utf8");
    userData = Buffer.from(decoded).toString("base64") === d.UserData.replace(/\s/g, "") ? decoded : d.UserData;
  }
  const profile = d.IamInstanceProfile as { Name?: string; Arn?: string } | undefined;
  return {
    imageId: d.ImageId,
    instanceType: d.InstanceType ?? "t3.micro",
    securityGroupIds: sgs,
    keyName: d.KeyName,
    iamRole: profile?.Name ?? profile?.Arn?.split("/").pop(),
    associatePublicIp: ni?.AssociatePublicIpAddress === undefined ? "subnet-default" : ni.AssociatePublicIpAddress ? "enable" : "disable",
    userData,
  };
}

// ---------- Auto Scaling ----------

async function groupByName(ctx: CliContext, name: string, notFound = `AutoScalingGroup name not found - AutoScalingGroup '${name}' not found`) {
  const g = (await listOf(ctx, "autoscaling", "auto-scaling-group")).find((x) => x.name === name);
  if (!g) throw new EngineError("ValidationError", notFound);
  return g;
}

/** --launch-template LaunchTemplateName=x or LaunchTemplateId=lt-… → the template's name. */
async function templateNameArg(ctx: CliContext, value: string): Promise<string> {
  const v = structured(value) as Record<string, string>;
  if (v.LaunchTemplateId) {
    const t = await ctx.engine.get(ctx.accountId, v.LaunchTemplateId).catch(() => null);
    if (!t || t.type !== "launch-template" || t.region !== ctx.region) {
      throw new EngineError(
        "ValidationError",
        `You must use a valid fully-formed launch template. The specified launch template, with template ID ${v.LaunchTemplateId}, does not exist.`,
      );
    }
    return t.name;
  }
  if (v.LaunchTemplateName) {
    if (!(await listOf(ctx, "compute", "launch-template")).some((t) => t.name === v.LaunchTemplateName)) {
      throw new EngineError(
        "ValidationError",
        `You must use a valid fully-formed launch template. The specified launch template, with template name ${v.LaunchTemplateName}, does not exist.`,
      );
    }
    return v.LaunchTemplateName;
  }
  throw new EngineError("ValidationError", "Valid requests must contain either LaunchTemplateId or LaunchTemplateName");
}

const members = async (ctx: CliContext, g: Resource) =>
  (await listOf(ctx, "compute", "instance")).filter((i) => systemOf(i).managedBy === g.id && i.state !== "terminated");

const LIFECYCLE: Record<string, string> = {
  pending: "Pending",
  running: "InService",
  rebooting: "InService",
  stopping: "InService",
  stopped: "InService",
  "shutting-down": "Terminating",
};

function instanceOut(i: Resource, g: Resource, t: Resource | undefined) {
  return {
    InstanceId: i.id,
    InstanceType: i.config.instanceType,
    AvailabilityZone: i.attributes.availabilityZone,
    LifecycleState: LIFECYCLE[i.state ?? ""] ?? "Pending",
    HealthStatus: i.state === "stopped" || i.state === "stopping" ? "Unhealthy" : "Healthy",
    LaunchTemplate: { LaunchTemplateId: t?.id, LaunchTemplateName: g.config.launchTemplate, Version: String(t?.attributes.latestVersion ?? 1) },
    ProtectedFromScaleIn: false,
  };
}

async function groupOut(ctx: CliContext, g: Resource) {
  const template = (await listOf(ctx, "compute", "launch-template")).find((t) => t.name === g.config.launchTemplate);
  const subnets = await Promise.all(((g.config.subnetIds as string[]) ?? []).map((id) => ctx.engine.get(ctx.accountId, id).catch(() => null)));
  return {
    AutoScalingGroupName: g.name,
    AutoScalingGroupARN: g.id,
    LaunchTemplate: { LaunchTemplateId: template?.id, LaunchTemplateName: g.config.launchTemplate, Version: "$Default" },
    MinSize: g.config.minSize,
    MaxSize: g.config.maxSize,
    DesiredCapacity: g.config.desiredCapacity,
    DefaultCooldown: 300,
    AvailabilityZones: [...new Set(subnets.filter((s): s is Resource => !!s).map((s) => s.config.availabilityZone))],
    LoadBalancerNames: [],
    TargetGroupARNs: g.config.targetGroupIds ?? [],
    HealthCheckType: g.config.healthCheckType,
    HealthCheckGracePeriod: g.config.healthCheckGracePeriod,
    Instances: (await members(ctx, g)).map((i) => instanceOut(i, g, template)),
    CreatedTime: g.createdAt,
    SuspendedProcesses: [],
    VPCZoneIdentifier: ((g.config.subnetIds as string[]) ?? []).join(","),
    EnabledMetrics: [],
    Tags: [],
    TerminationPolicies: ["Default"],
    NewInstancesProtectedFromScaleIn: false,
    ServiceLinkedRoleARN: `arn:aws:iam::${accountNumber(ctx.accountId)}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling`,
  };
}

const uuidOf = (text: string) => {
  const h = createHash("sha1").update(text).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

const activityOut = (g: Resource, a: Activity) => ({
  ActivityId: uuidOf(`${g.id}:${a.at}:${a.description}`),
  AutoScalingGroupName: g.name,
  Description: a.description,
  Cause: `At ${a.at.replace(/\.\d{3}Z$/, "Z")} ${a.cause}`,
  StartTime: a.at,
  EndTime: a.at,
  StatusCode: a.status,
  Progress: 100,
  Details: JSON.stringify({ "Subnet ID": "", "Availability Zone": "" }),
  AutoScalingGroupARN: g.id,
});

function policyOut(ctx: CliContext, g: Resource) {
  const name = String(g.attributes.policyName ?? "cpu-target-tracking");
  return {
    AutoScalingGroupName: g.name,
    PolicyName: name,
    PolicyARN: `arn:aws:autoscaling:${ctx.region}:${accountNumber(ctx.accountId)}:scalingPolicy:${uuidOf(g.id + name)}:autoScalingGroupName/${g.name}:policyName/${name}`,
    PolicyType: "TargetTrackingScaling",
    StepAdjustments: [],
    Alarms: alarms(ctx, g, name),
    TargetTrackingConfiguration: {
      PredefinedMetricSpecification: { PredefinedMetricType: "ASGAverageCPUUtilization" },
      TargetValue: Number(g.config.targetCpu),
      DisableScaleIn: false,
    },
    Enabled: true,
  };
}

function alarms(ctx: CliContext, g: Resource, policy: string) {
  const id = uuidOf(g.id + policy);
  const arn = (kind: string) => `arn:aws:cloudwatch:${ctx.region}:${accountNumber(ctx.accountId)}:alarm:TargetTracking-${g.name}-${kind}-${id}`;
  return [
    { AlarmName: `TargetTracking-${g.name}-AlarmHigh-${id}`, AlarmARN: arn("AlarmHigh") },
    { AlarmName: `TargetTracking-${g.name}-AlarmLow-${id}`, AlarmARN: arn("AlarmLow") },
  ];
}

// ---------- commands ----------

export const ELB_COMMANDS: Command[] = [
  // --- target groups ---
  cmd({
    service: "elbv2",
    operation: "create-target-group",
    apiName: "CreateTargetGroup",
    summary: "Create a target group (the servers a load balancer sends traffic to)",
    usage: "--name <name> --protocol HTTP --port <port> --vpc-id <vpc-id> [--health-check-path <path>] [--target-type instance]",
    mutates: true,
    async run(args, ctx) {
      const protocol = (args.one("protocol") ?? "HTTP").toUpperCase();
      if (protocol !== "HTTP") throw new EngineError("ValidationError", `CloudLab simulates HTTP target groups only, not '${protocol}'`);
      const type = args.one("target-type") ?? "instance";
      if (type !== "instance") throw new EngineError("ValidationError", `CloudLab supports target type 'instance' only, not '${type}'`);
      const port = nums(args, "port");
      if (port === undefined) throw new EngineError("ValidationError", "A port must be specified");
      const vpcId = args.one("vpc-id");
      if (!vpcId) throw new EngineError("ValidationError", "A VPC ID must be specified");
      const tg = await create(ctx, "loadbalancing", "target-group", {
        name: args.required("name"),
        protocol,
        port,
        vpcId,
        healthCheckPath: args.one("health-check-path") ?? "/",
      });
      return { TargetGroups: [await tgOut(ctx, tg)] };
    },
  }),
  cmd({
    service: "elbv2",
    operation: "describe-target-groups",
    apiName: "DescribeTargetGroups",
    summary: "List target groups",
    usage: "[--target-group-arns <arn> ...] [--names <name> ...] [--load-balancer-arn <arn>]",
    mutates: false,
    async run(args, ctx) {
      const arns = args.list("target-group-arns");
      const names = args.list("names");
      const lbArn = args.one("load-balancer-arn");
      let items = arns.length ? await Promise.all(arns.map((a) => load(ctx, "loadbalancing", "target-group", a))) : await listOf(ctx, "loadbalancing", "target-group");
      if (names.length) {
        const missing = names.filter((n) => !items.some((t) => t.name === n));
        if (missing.length) throw new EngineError("TargetGroupNotFound", `One or more target groups not found`);
        items = items.filter((t) => names.includes(t.name));
      }
      if (lbArn) {
        const lb = await load(ctx, "loadbalancing", "load-balancer", lbArn);
        const ids = new Set(listenersOf(lb).map((l) => l.targetGroupId));
        items = items.filter((t) => ids.has(t.id));
      }
      return { TargetGroups: await Promise.all(items.map((t) => tgOut(ctx, t))) };
    },
  }),
  cmd({
    service: "elbv2",
    operation: "delete-target-group",
    apiName: "DeleteTargetGroup",
    summary: "Delete a target group",
    usage: "--target-group-arn <arn>",
    mutates: true,
    async run(args, ctx) {
      const tg = await load(ctx, "loadbalancing", "target-group", args.required("target-group-arn"));
      await ctx.engine.remove(ctx.accountId, tg.id);
    },
  }),
  cmd({
    service: "elbv2",
    operation: "register-targets",
    apiName: "RegisterTargets",
    summary: "Add instances to a target group",
    usage: "--target-group-arn <arn> --targets Id=<instance-id> ...",
    mutates: true,
    async run(args, ctx) {
      const tg = await load(ctx, "loadbalancing", "target-group", args.required("target-group-arn"));
      const ids = targetIds(args);
      for (const id of ids) {
        const inst = await ctx.engine.get(ctx.accountId, id).catch(() => null);
        if (!inst || inst.type !== "instance" || inst.region !== ctx.region) throw new EngineError("InvalidTarget", `The following targets are not valid instances: '${id}'`);
        if (inst.state === "terminated" || inst.state === "shutting-down") {
          throw new EngineError("InvalidTarget", `The following targets are not in a running state and cannot be registered: '${id}'`);
        }
      }
      const current = (tg.config.targets as string[]) ?? [];
      await ctx.engine.update(ctx.accountId, tg.id, { targets: [...new Set([...current, ...ids])] });
    },
  }),
  cmd({
    service: "elbv2",
    operation: "deregister-targets",
    apiName: "DeregisterTargets",
    summary: "Remove instances from a target group",
    usage: "--target-group-arn <arn> --targets Id=<instance-id> ...",
    mutates: true,
    async run(args, ctx) {
      const tg = await load(ctx, "loadbalancing", "target-group", args.required("target-group-arn"));
      const ids = targetIds(args);
      const current = (tg.config.targets as string[]) ?? [];
      const missing = ids.filter((id) => !current.includes(id));
      if (missing.length) throw new EngineError("InvalidTarget", `The following targets are not registered in target group: '${missing.join("', '")}'`);
      await ctx.engine.update(ctx.accountId, tg.id, { targets: current.filter((id) => !ids.includes(id)) });
    },
  }),
  cmd({
    service: "elbv2",
    operation: "describe-target-health",
    apiName: "DescribeTargetHealth",
    summary: "Show whether each target passes health checks, and why not",
    usage: "--target-group-arn <arn>",
    mutates: false,
    async run(args, ctx) {
      const tg = await load(ctx, "loadbalancing", "target-group", args.required("target-group-arn"));
      const health = await targetHealth(ctx.engine, ctx.accountId, tg, ctx.engine.now());
      return {
        TargetHealthDescriptions: health.map((h) => ({
          Target: { Id: h.id, Port: h.port, ...(h.availabilityZone ? { AvailabilityZone: h.availabilityZone } : {}) },
          HealthCheckPort: String(h.port),
          TargetHealth: { State: h.state, ...(h.reason ? { Reason: h.reason, Description: h.description } : {}) },
        })),
      };
    },
  }),

  // --- load balancers ---
  cmd({
    service: "elbv2",
    operation: "create-load-balancer",
    apiName: "CreateLoadBalancer",
    summary: "Create an application load balancer",
    usage: "--name <name> --subnets <subnet-id> ... [--security-groups <sg-id> ...] [--scheme internet-facing|internal] [--type application]",
    mutates: true,
    async run(args, ctx) {
      const type = args.one("type") ?? "application";
      if (type !== "application") throw new EngineError("ValidationError", `CloudLab simulates application load balancers only, not '${type}'`);
      const subnetIds = args.list("subnets");
      if (subnetIds.length === 0) throw new EngineError("ValidationError", "At least two subnets in two different Availability Zones must be specified");
      let securityGroupIds = args.list("security-groups");
      if (securityGroupIds.length === 0) {
        // Like AWS, no group given means the VPC's default security group.
        const first = await load(ctx, "networking", "subnet", subnetIds[0]);
        const def = (await listOf(ctx, "networking", "security-group")).find((g) => g.config.vpcId === first.config.vpcId && systemOf(g).isDefault);
        securityGroupIds = def ? [def.id] : [];
      }
      const lb = await create(ctx, "loadbalancing", "load-balancer", {
        name: args.required("name"),
        scheme: args.one("scheme") ?? "internet-facing",
        subnetIds,
        securityGroupIds,
        listeners: [],
      });
      return { LoadBalancers: [await lbOut(ctx, lb)] };
    },
  }),
  cmd({
    service: "elbv2",
    operation: "describe-load-balancers",
    apiName: "DescribeLoadBalancers",
    summary: "List load balancers and their DNS names",
    usage: "[--load-balancer-arns <arn> ...] [--names <name> ...]",
    mutates: false,
    async run(args, ctx) {
      const arns = args.list("load-balancer-arns");
      const names = args.list("names");
      let items = arns.length
        ? await Promise.all(arns.map((a) => load(ctx, "loadbalancing", "load-balancer", a)))
        : await listOf(ctx, "loadbalancing", "load-balancer");
      if (names.length) {
        const missing = names.filter((n) => !items.some((l) => l.name === n));
        if (missing.length) throw new EngineError("LoadBalancerNotFound", `Load balancers '[${missing.join(", ")}]' not found`);
        items = items.filter((l) => names.includes(l.name));
      }
      return { LoadBalancers: await Promise.all(items.map((l) => lbOut(ctx, l))) };
    },
  }),
  cmd({
    service: "elbv2",
    operation: "delete-load-balancer",
    apiName: "DeleteLoadBalancer",
    summary: "Delete a load balancer and its listeners",
    usage: "--load-balancer-arn <arn>",
    mutates: true,
    async run(args, ctx) {
      const lb = await load(ctx, "loadbalancing", "load-balancer", args.required("load-balancer-arn"));
      await ctx.engine.remove(ctx.accountId, lb.id);
    },
  }),

  // --- listeners ---
  cmd({
    service: "elbv2",
    operation: "create-listener",
    apiName: "CreateListener",
    summary: "Accept traffic on a port and forward it to a target group",
    usage: "--load-balancer-arn <arn> --protocol HTTP --port <port> --default-actions Type=forward,TargetGroupArn=<arn>",
    mutates: true,
    async run(args, ctx) {
      const lb = await load(ctx, "loadbalancing", "load-balancer", args.required("load-balancer-arn"));
      const protocol = (args.one("protocol") ?? "HTTP").toUpperCase();
      if (protocol !== "HTTP") throw new EngineError("ValidationError", `CloudLab simulates HTTP listeners only, not '${protocol}'`);
      const port = nums(args, "port");
      if (port === undefined) throw new EngineError("ValidationError", "A listener port must be specified");
      const targetGroupId = forwardTarget(args);
      await load(ctx, "loadbalancing", "target-group", targetGroupId);
      const listener: Listener = { protocol, port, targetGroupId };
      const updated = await ctx.engine.update(ctx.accountId, lb.id, { listeners: [...listenersOf(lb), listener] });
      return { Listeners: [listenerOut(updated, listener)] };
    },
  }),
  cmd({
    service: "elbv2",
    operation: "describe-listeners",
    apiName: "DescribeListeners",
    summary: "List a load balancer's listeners",
    usage: "[--load-balancer-arn <arn>] [--listener-arns <arn> ...]",
    mutates: false,
    async run(args, ctx) {
      const lbArn = args.one("load-balancer-arn");
      const arns = args.list("listener-arns");
      if (!lbArn && arns.length === 0) throw new EngineError("ValidationError", "You must specify either listener ARNs or a load balancer ARN");
      if (lbArn) {
        const lb = await load(ctx, "loadbalancing", "load-balancer", lbArn);
        return { Listeners: listenersOf(lb).map((l) => listenerOut(lb, l)) };
      }
      const found = await Promise.all(arns.map((a) => findListener(ctx, a)));
      return { Listeners: found.map(({ lb, listener }) => listenerOut(lb, listener)) };
    },
  }),
  cmd({
    service: "elbv2",
    operation: "delete-listener",
    apiName: "DeleteListener",
    summary: "Delete a listener",
    usage: "--listener-arn <arn>",
    mutates: true,
    async run(args, ctx) {
      const { lb, listener } = await findListener(ctx, args.required("listener-arn"));
      await ctx.engine.update(ctx.accountId, lb.id, { listeners: listenersOf(lb).filter((l) => Number(l.port) !== Number(listener.port)) });
    },
  }),

  // --- launch templates (ec2) ---
  cmd({
    service: "ec2",
    operation: "create-launch-template",
    apiName: "CreateLaunchTemplate",
    summary: "Save a recipe for launching instances",
    usage: '--launch-template-name <name> --launch-template-data \'{"ImageId":"ami-…","InstanceType":"t3.micro","SecurityGroupIds":["sg-…"]}\'',
    mutates: true,
    async run(args, ctx) {
      const name = args.required("launch-template-name");
      const data = args.raw("launch-template-data");
      if (data.length === 0) throw new UsageError("the following arguments are required: --launch-template-data");
      const t = await create(ctx, "compute", "launch-template", { name, ...templateConfig(data.join(" ")) });
      return { LaunchTemplate: templateOut(ctx, t) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-launch-templates",
    apiName: "DescribeLaunchTemplates",
    summary: "List launch templates",
    usage: "[--launch-template-ids <lt-id> ...] [--launch-template-names <name> ...]",
    mutates: false,
    async run(args, ctx) {
      const ids = args.list("launch-template-ids");
      const names = args.list("launch-template-names");
      let items = ids.length ? await Promise.all(ids.map((id) => load(ctx, "compute", "launch-template", id))) : await listOf(ctx, "compute", "launch-template");
      if (names.length) {
        if (names.some((n) => !items.some((t) => t.name === n))) {
          throw new EngineError("InvalidLaunchTemplateName.NotFoundException", "At least one of the launch templates specified in the request does not exist.");
        }
        items = items.filter((t) => names.includes(t.name));
      }
      return { LaunchTemplates: items.map((t) => templateOut(ctx, t)) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-launch-template-versions",
    apiName: "DescribeLaunchTemplateVersions",
    summary: "Show what a launch template launches",
    usage: "--launch-template-id <lt-id> | --launch-template-name <name>",
    mutates: false,
    async run(args, ctx) {
      const t = (await templateBy(ctx, args))!;
      return {
        LaunchTemplateVersions: [
          {
            LaunchTemplateId: t.id,
            LaunchTemplateName: t.name,
            VersionNumber: t.attributes.latestVersion ?? 1,
            CreateTime: t.updatedAt,
            CreatedBy: `arn:aws:iam::${accountNumber(ctx.accountId)}:root`,
            DefaultVersion: true,
            LaunchTemplateData: templateData(t),
          },
        ],
      };
    },
  }),
  cmd({
    service: "ec2",
    operation: "create-launch-template-version",
    apiName: "CreateLaunchTemplateVersion",
    summary: "Change a launch template (new instances use the new version)",
    usage: "--launch-template-id <lt-id> | --launch-template-name <name> --launch-template-data <json>",
    mutates: true,
    async run(args, ctx) {
      const t = (await templateBy(ctx, args))!;
      const data = args.raw("launch-template-data");
      if (data.length === 0) throw new UsageError("the following arguments are required: --launch-template-data");
      const patch = Object.fromEntries(Object.entries(templateConfig(data.join(" "))).filter(([, v]) => v !== undefined));
      const updated = await ctx.engine.update(ctx.accountId, t.id, patch);
      return {
        LaunchTemplateVersion: {
          LaunchTemplateId: updated.id,
          LaunchTemplateName: updated.name,
          VersionNumber: updated.attributes.latestVersion,
          CreateTime: updated.updatedAt,
          DefaultVersion: true,
          LaunchTemplateData: templateData(updated),
        },
      };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-launch-template",
    apiName: "DeleteLaunchTemplate",
    summary: "Delete a launch template",
    usage: "--launch-template-id <lt-id> | --launch-template-name <name>",
    mutates: true,
    async run(args, ctx) {
      const t = (await templateBy(ctx, args))!;
      await ctx.engine.remove(ctx.accountId, t.id);
      return { LaunchTemplate: templateOut(ctx, t) };
    },
  }),

  // --- Auto Scaling ---
  cmd({
    service: "autoscaling",
    operation: "create-auto-scaling-group",
    apiName: "CreateAutoScalingGroup",
    summary: "Create a group that keeps a number of healthy instances running",
    usage:
      "--auto-scaling-group-name <name> --launch-template LaunchTemplateName=<name> --min-size <n> --max-size <n> [--desired-capacity <n>] --vpc-zone-identifier <subnet-a,subnet-b> [--target-group-arns <arn> ...] [--health-check-type EC2|ELB] [--health-check-grace-period <seconds>]",
    mutates: true,
    async run(args, ctx) {
      const lt = args.one("launch-template");
      if (!lt) throw new EngineError("ValidationError", "Valid requests must contain either LaunchTemplate, LaunchConfigurationName, InstanceId or MixedInstancesPolicy parameter.");
      const min = nums(args, "min-size");
      const max = nums(args, "max-size");
      if (min === undefined) throw new UsageError("the following arguments are required: --min-size");
      if (max === undefined) throw new UsageError("the following arguments are required: --max-size");
      const subnetIds = args.list("vpc-zone-identifier");
      if (subnetIds.length === 0) {
        throw new EngineError("ValidationError", "CloudLab needs --vpc-zone-identifier with the subnets to launch into, e.g. subnet-aaa,subnet-bbb");
      }
      await create(ctx, "autoscaling", "auto-scaling-group", {
        name: args.required("auto-scaling-group-name"),
        launchTemplate: await templateNameArg(ctx, lt),
        subnetIds,
        minSize: min,
        maxSize: max,
        desiredCapacity: nums(args, "desired-capacity") ?? min,
        targetGroupIds: args.list("target-group-arns"),
        healthCheckType: args.one("health-check-type") ?? "EC2",
        healthCheckGracePeriod: nums(args, "health-check-grace-period") ?? 30,
        simulatedTraffic: "normal",
      });
      // Launch the first instances straight away, as AWS starts doing as soon as the group exists.
      await ctx.engine.ensureDefaults(ctx.accountId, ctx.region);
    },
  }),
  cmd({
    service: "autoscaling",
    operation: "describe-auto-scaling-groups",
    apiName: "DescribeAutoScalingGroups",
    summary: "List Auto Scaling groups and their instances",
    usage: "[--auto-scaling-group-names <name> ...]",
    mutates: false,
    async run(args, ctx) {
      const names = args.list("auto-scaling-group-names");
      const groups = (await listOf(ctx, "autoscaling", "auto-scaling-group")).filter((g) => names.length === 0 || names.includes(g.name));
      return { AutoScalingGroups: await Promise.all(groups.map((g) => groupOut(ctx, g))) };
    },
  }),
  cmd({
    service: "autoscaling",
    operation: "describe-auto-scaling-instances",
    apiName: "DescribeAutoScalingInstances",
    summary: "List instances that belong to Auto Scaling groups",
    usage: "[--instance-ids <id> ...]",
    mutates: false,
    async run(args, ctx) {
      const ids = args.list("instance-ids");
      const groups = await listOf(ctx, "autoscaling", "auto-scaling-group");
      const templates = await listOf(ctx, "compute", "launch-template");
      const out = [];
      for (const g of groups) {
        const t = templates.find((x) => x.name === g.config.launchTemplate);
        for (const i of await members(ctx, g)) {
          if (ids.length && !ids.includes(i.id)) continue;
          const { LifecycleState, HealthStatus, ...rest } = instanceOut(i, g, t);
          out.push({ ...rest, AutoScalingGroupName: g.name, LifecycleState, HealthStatus: HealthStatus.toUpperCase() });
        }
      }
      return { AutoScalingInstances: out };
    },
  }),
  cmd({
    service: "autoscaling",
    operation: "update-auto-scaling-group",
    apiName: "UpdateAutoScalingGroup",
    summary: "Change a group's size, subnets, template or health checks",
    usage:
      "--auto-scaling-group-name <name> [--min-size <n>] [--max-size <n>] [--desired-capacity <n>] [--launch-template LaunchTemplateName=<name>] [--vpc-zone-identifier <subnets>] [--health-check-type EC2|ELB] [--health-check-grace-period <seconds>]",
    mutates: true,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("auto-scaling-group-name"), "AutoScalingGroup name not found - null");
      const patch: Record<string, unknown> = {};
      const set = (key: string, v: unknown) => v !== undefined && (patch[key] = v);
      set("minSize", nums(args, "min-size"));
      set("maxSize", nums(args, "max-size"));
      set("desiredCapacity", nums(args, "desired-capacity"));
      set("healthCheckType", args.one("health-check-type"));
      set("healthCheckGracePeriod", nums(args, "health-check-grace-period"));
      if (args.has("vpc-zone-identifier")) patch.subnetIds = args.list("vpc-zone-identifier");
      const lt = args.one("launch-template");
      if (lt) patch.launchTemplate = await templateNameArg(ctx, lt);
      // As in AWS, changing min or max pulls the desired capacity into the new range.
      const min = Number(patch.minSize ?? g.config.minSize);
      const max = Number(patch.maxSize ?? g.config.maxSize);
      if (patch.desiredCapacity === undefined && min <= max) {
        const desired = Number(g.config.desiredCapacity);
        if (desired < min) patch.desiredCapacity = min;
        if (desired > max) patch.desiredCapacity = max;
      }
      await ctx.engine.update(ctx.accountId, g.id, patch);
      await ctx.engine.ensureDefaults(ctx.accountId, ctx.region);
    },
  }),
  cmd({
    service: "autoscaling",
    operation: "set-desired-capacity",
    apiName: "SetDesiredCapacity",
    summary: "Ask for a different number of instances",
    usage: "--auto-scaling-group-name <name> --desired-capacity <n> [--honor-cooldown]",
    mutates: true,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("auto-scaling-group-name"), "AutoScalingGroup name not found - null");
      const n = nums(args, "desired-capacity");
      if (n === undefined) throw new UsageError("the following arguments are required: --desired-capacity");
      if (n > Number(g.config.maxSize)) {
        throw new EngineError("ValidationError", `New SetDesiredCapacity value ${n} is above max value ${g.config.maxSize} for the AutoScalingGroup.`);
      }
      if (n < Number(g.config.minSize)) {
        throw new EngineError("ValidationError", `New SetDesiredCapacity value ${n} is below min value ${g.config.minSize} for the AutoScalingGroup.`);
      }
      await ctx.engine.update(ctx.accountId, g.id, { desiredCapacity: n });
      await ctx.engine.ensureDefaults(ctx.accountId, ctx.region);
    },
  }),
  cmd({
    service: "autoscaling",
    operation: "delete-auto-scaling-group",
    apiName: "DeleteAutoScalingGroup",
    summary: "Delete a group (--force-delete also terminates its instances)",
    usage: "--auto-scaling-group-name <name> [--force-delete]",
    mutates: true,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("auto-scaling-group-name"));
      await ctx.engine.remove(ctx.accountId, g.id, { force: args.bool("force-delete") === true });
    },
  }),
  cmd({
    service: "autoscaling",
    operation: "describe-scaling-activities",
    apiName: "DescribeScalingActivities",
    summary: "See what a group did and why: launches, terminations, scaling",
    usage: "[--auto-scaling-group-name <name>] [--max-items <n>]",
    mutates: false,
    async run(args, ctx) {
      const name = args.one("auto-scaling-group-name");
      const groups = name ? [await groupByName(ctx, name)] : await listOf(ctx, "autoscaling", "auto-scaling-group");
      const all = groups
        .flatMap((g) => ((g.attributes.activities as Activity[] | undefined) ?? []).map((a) => activityOut(g, a)))
        .sort((a, b) => b.StartTime.localeCompare(a.StartTime));
      const max = nums(args, "max-items");
      return { Activities: max ? all.slice(0, max) : all };
    },
  }),
  cmd({
    service: "autoscaling",
    operation: "put-scaling-policy",
    apiName: "PutScalingPolicy",
    summary: "Add a target tracking policy (scale on average CPU)",
    usage:
      '--auto-scaling-group-name <name> --policy-name <name> --policy-type TargetTrackingScaling --target-tracking-configuration \'{"PredefinedMetricSpecification":{"PredefinedMetricType":"ASGAverageCPUUtilization"},"TargetValue":50}\'',
    mutates: true,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("auto-scaling-group-name"), "AutoScalingGroup name not found - null");
      const policyName = args.required("policy-name");
      const type = args.one("policy-type") ?? "SimpleScaling";
      if (type !== "TargetTrackingScaling") {
        throw new EngineError("ValidationError", `CloudLab simulates TargetTrackingScaling policies only, not '${type}'`);
      }
      const raw = args.raw("target-tracking-configuration");
      if (raw.length === 0) throw new EngineError("ValidationError", "TargetTrackingConfiguration is required for policy type TargetTrackingScaling");
      const conf = structured(raw.join(" ")) as { PredefinedMetricSpecification?: { PredefinedMetricType?: string }; TargetValue?: number };
      const metric = conf.PredefinedMetricSpecification?.PredefinedMetricType;
      if (metric !== "ASGAverageCPUUtilization") {
        throw new EngineError("ValidationError", `CloudLab simulates the ASGAverageCPUUtilization metric only${metric ? `, not '${metric}'` : ""}`);
      }
      const target = Number(conf.TargetValue);
      if (!Number.isFinite(target)) throw new EngineError("ValidationError", "TargetValue is required");
      if (target < 10 || target > 90) throw new EngineError("ValidationError", "CloudLab accepts a TargetValue between 10 and 90 for CPU utilization");
      const other = g.attributes.policyName;
      if (g.config.targetCpu && other && other !== policyName) {
        throw new EngineError("ValidationError", `CloudLab supports one scaling policy per group; delete '${other}' first`);
      }
      const updated = await ctx.engine.update(ctx.accountId, g.id, { targetCpu: Math.round(target) });
      await ctx.engine.setAttributes(ctx.accountId, g.id, { policyName });
      const out = policyOut(ctx, { ...updated, attributes: { ...updated.attributes, policyName } });
      return { PolicyARN: out.PolicyARN, Alarms: out.Alarms };
    },
  }),
  cmd({
    service: "autoscaling",
    operation: "describe-policies",
    apiName: "DescribePolicies",
    summary: "List scaling policies",
    usage: "[--auto-scaling-group-name <name>]",
    mutates: false,
    async run(args, ctx) {
      const name = args.one("auto-scaling-group-name");
      const groups = (await listOf(ctx, "autoscaling", "auto-scaling-group")).filter((g) => !name || g.name === name);
      return { ScalingPolicies: groups.filter((g) => g.config.targetCpu).map((g) => policyOut(ctx, g)) };
    },
  }),
  cmd({
    service: "autoscaling",
    operation: "delete-policy",
    apiName: "DeletePolicy",
    summary: "Remove a scaling policy (the group stays at its current size)",
    usage: "--auto-scaling-group-name <name> --policy-name <name>",
    mutates: true,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("auto-scaling-group-name"), "AutoScalingGroup name not found - null");
      const policyName = args.required("policy-name");
      if (!g.config.targetCpu || String(g.attributes.policyName ?? "cpu-target-tracking") !== policyName) {
        throw new EngineError("ValidationError", `Policy ${policyName} not found`);
      }
      await ctx.engine.update(ctx.accountId, g.id, { targetCpu: undefined });
      await ctx.engine.setAttributes(ctx.accountId, g.id, { policyName: null });
    },
  }),
  cmd({
    service: "autoscaling",
    operation: "terminate-instance-in-auto-scaling-group",
    apiName: "TerminateInstanceInAutoScalingGroup",
    summary: "Terminate one of a group's instances, with or without a replacement",
    usage: "--instance-id <id> --should-decrement-desired-capacity | --no-should-decrement-desired-capacity",
    mutates: true,
    async run(args, ctx) {
      const id = args.required("instance-id");
      const decrement = args.bool("should-decrement-desired-capacity");
      if (decrement === undefined) {
        throw new UsageError("the following arguments are required: --should-decrement-desired-capacity | --no-should-decrement-desired-capacity");
      }
      const inst = await ctx.engine.get(ctx.accountId, id).catch(() => null);
      const g = inst && systemOf(inst).managedBy ? await ctx.engine.get(ctx.accountId, String(systemOf(inst).managedBy)).catch(() => null) : null;
      if (!inst || !g || inst.state === "terminated") throw new EngineError("ValidationError", `Instance Id not found - No managed instance found for instance ID: ${id}`);
      const desired = Number(g.config.desiredCapacity);
      if (decrement) {
        if (desired <= Number(g.config.minSize)) {
          throw new EngineError(
            "ValidationError",
            `Currently, desiredSize equals minSize (${g.config.minSize}). Terminating instance without replacement will violate group's min size constraint. Either set shouldDecrementDesiredCapacity flag to false or lower group's min size.`,
          );
        }
        await ctx.engine.update(ctx.accountId, g.id, { desiredCapacity: desired - 1 });
      }
      await ctx.engine.runAction(ctx.accountId, id, "terminate");
      const at = ctx.engine.now().toISOString();
      const activity: Activity = {
        at,
        description: `Terminating EC2 instance: ${id}`,
        cause: decrement
          ? `instance ${id} was taken out of service in response to a user request, shrinking the capacity from ${desired} to ${desired - 1}.`
          : `instance ${id} was taken out of service in response to a user request.`,
        status: "Successful",
      };
      const previous = (g.attributes.activities as Activity[] | undefined) ?? [];
      await ctx.engine.setAttributes(ctx.accountId, g.id, { activities: [activity, ...previous].slice(0, 30) });
      await ctx.engine.ensureDefaults(ctx.accountId, ctx.region);
      return { Activity: { ...activityOut(g, activity), StatusCode: "InProgress", Progress: 0 } };
    },
  }),
];
