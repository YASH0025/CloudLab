import { REGIONS, availabilityZones } from "@/engine/catalog";
import type { Engine } from "@/engine/engine";
import { EngineError } from "@/engine/errors";
import { getTypeDef } from "@/engine/registry";
import type { Resource } from "@/engine/types";
import { parseShorthand, UsageError } from "./parse";
import * as present from "./present";

export interface CliContext {
  engine: Engine;
  accountId: string;
  region: string;
}

/** Typed access to a command's --options. */
export class Args {
  constructor(
    private options: Map<string, string[]>,
    readonly positionals: string[],
  ) {}

  has(name: string) {
    return this.options.has(name);
  }

  one(name: string): string | undefined {
    const v = this.options.get(name);
    if (v === undefined) return undefined;
    if (v.length === 0) throw new UsageError(`argument --${name}: expected one argument`);
    return v[0];
  }

  required(name: string): string {
    const v = this.one(name);
    if (v === undefined) throw new UsageError(`the following arguments are required: --${name}`);
    return v;
  }

  /** Raw values exactly as typed (no comma splitting), for structured options. */
  raw(name: string): string[] {
    return this.options.get(name) ?? [];
  }

  list(name: string): string[] {
    // Accept both `--ids a b` and `--ids a,b`.
    return (this.options.get(name) ?? []).flatMap((v) => v.split(",")).filter(Boolean);
  }

  /** `--flag` → true, `--no-flag` → false, neither → undefined. */
  bool(name: string): boolean | undefined {
    if (this.options.has(name)) return true;
    if (this.options.has(`no-${name}`)) return false;
    return undefined;
  }
}

export interface Command {
  service: string;
  operation: string;
  /** API operation name used in error messages, e.g. "CreateVpc". */
  apiName: string;
  summary: string;
  usage?: string;
  /** Changes resources, so the console should refresh afterwards. */
  mutates: boolean;
  run(args: Args, ctx: CliContext): Promise<unknown>;
}

// ---------- helpers ----------

/** Loads a resource of a given type in the current region, or fails like the real API would. */
async function load(ctx: CliContext, service: string, type: string, id: string, noun: string): Promise<Resource> {
  const r = await ctx.engine.get(ctx.accountId, id).catch(() => null);
  if (!r || r.service !== service || r.type !== type || r.region !== ctx.region) {
    throw new EngineError(getTypeDef(service, type).notFoundCode, `The ${noun} ID '${id}' does not exist`, 404);
  }
  return r;
}

async function listOf(ctx: CliContext, service: string, type: string) {
  return ctx.engine.list(ctx.accountId, { service, type, region: ctx.region });
}

const create = (ctx: CliContext, service: string, type: string, config: Record<string, unknown>) =>
  ctx.engine.create(ctx.accountId, { service, type, region: ctx.region, config });

/** Reads `Key=Name,Value=x` from --tag-specifications in shorthand or JSON form. */
function nameTag(args: Args): string | undefined {
  const all = args.raw("tag-specifications").join(" ");
  if (!all) return undefined;
  const m = /"?Key"?\s*[:=]\s*"?Name"?\s*,\s*"?Value"?\s*[:=]\s*"?([^"}\],]+)/.exec(all);
  return m?.[1]?.trim();
}

/** Applies --filters Name=x,Values=a,b to resources. */
function applyFilters(args: Args, items: Resource[]): Resource[] {
  return args.raw("filters").reduce((acc, raw) => {
    const f = parseShorthand(raw);
    const name = String(f.Name ?? "");
    const values = ([] as string[]).concat(f.Values ?? []);
    const pick = (r: Resource): unknown => {
      if (name === "vpc-id") return r.config.vpcId ?? r.attributes.vpcId;
      if (name === "subnet-id") return r.config.subnetId;
      if (name === "instance-state-name" || name === "state") return r.state;
      if (name === "availability-zone") return r.config.availabilityZone ?? r.attributes.availabilityZone;
      if (name === "tag:Name") return r.name;
      if (name === "group-name") return r.config.name;
      throw new UsageError(`filter '${name}' is not supported in CloudLab yet`);
    };
    return acc.filter((r) => values.includes(String(pick(r))));
  }, items);
}

async function describe(
  ctx: CliContext,
  args: Args,
  opts: { service: string; type: string; idsOption: string; noun: string },
) {
  const ids = args.list(opts.idsOption);
  const items = ids.length
    ? await Promise.all(ids.map((id) => load(ctx, opts.service, opts.type, id, opts.noun)))
    : await listOf(ctx, opts.service, opts.type);
  return applyFilters(args, items);
}

const pctx = (ctx: CliContext): present.PresentContext => ({ engine: ctx.engine, accountId: ctx.accountId });

interface Rule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidr: string;
  description?: string;
}

/** Reads --protocol/--port/--cidr into a security group rule. */
function ruleFromArgs(args: Args): Rule {
  let protocol = args.required("protocol").toLowerCase();
  if (protocol === "-1") protocol = "all";
  if (!["tcp", "udp", "icmp", "all"].includes(protocol)) {
    throw new EngineError("InvalidParameterValue", `Invalid value '${protocol}' for IP protocol.`);
  }
  const cidr = args.one("cidr") ?? "0.0.0.0/0";
  if (protocol !== "tcp" && protocol !== "udp") return { protocol, cidr };
  const port = args.required("port");
  const [from, to = from] = port.split("-");
  const fromPort = Number(from);
  const toPort = Number(to);
  if (!Number.isInteger(fromPort) || !Number.isInteger(toPort)) {
    throw new EngineError("InvalidParameterValue", `Invalid port '${port}'. Use a number like 80 or a range like 8000-8080.`);
  }
  return { protocol, fromPort, toPort, cidr };
}

const sameRule = (a: Rule, b: Rule) =>
  a.protocol === b.protocol && a.cidr === b.cidr && (a.fromPort ?? -1) === (b.fromPort ?? -1) && (a.toPort ?? -1) === (b.toPort ?? -1);

/** Runs a lifecycle action on several instances and reports state changes like the real API. */
async function instanceAction(ctx: CliContext, args: Args, action: string) {
  const ids = args.list("instance-ids");
  if (ids.length === 0) throw new UsageError("the following arguments are required: --instance-ids");
  const changes = [];
  for (const id of ids) {
    const before = await load(ctx, "compute", "instance", id, "instance");
    const after = await ctx.engine.runAction(ctx.accountId, id, action);
    changes.push({
      CurrentState: present.instanceState(after.state),
      InstanceId: id,
      PreviousState: present.instanceState(before.state),
    });
  }
  return changes;
}

function bucketFromUri(uri: string | undefined): string {
  if (!uri) throw new UsageError("the following arguments are required: path");
  const m = /^s3:\/\/([^/]+)\/?$/.exec(uri);
  if (!m) throw new UsageError(`invalid S3 URI '${uri}'; expected s3://bucket-name`);
  return m[1];
}

async function loadBucket(ctx: CliContext, name: string) {
  const r = await ctx.engine.get(ctx.accountId, name).catch(() => null);
  if (!r || r.service !== "storage" || r.type !== "bucket") {
    throw new EngineError("NoSuchBucket", "The specified bucket does not exist", 404);
  }
  return r;
}

// ---------- commands ----------

const cmd = (c: Command) => c;

export const COMMANDS: Command[] = [
  // --- account / region ---
  cmd({
    service: "sts",
    operation: "get-caller-identity",
    apiName: "GetCallerIdentity",
    summary: "Show which lab account you are using",
    mutates: false,
    async run(_args, ctx) {
      const account = present.ownerId(ctx.accountId);
      return { UserId: ctx.accountId.toUpperCase(), Account: account, Arn: `arn:lab:iam::${account}:user/learner` };
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-regions",
    apiName: "DescribeRegions",
    summary: "List regions",
    mutates: false,
    async run() {
      return {
        Regions: REGIONS.map((r) => ({ Endpoint: `ec2.${r.code}.cloudlab.local`, RegionName: r.code, OptInStatus: "opt-in-not-required" })),
      };
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-availability-zones",
    apiName: "DescribeAvailabilityZones",
    summary: "List availability zones in the region",
    mutates: false,
    async run(_args, ctx) {
      return {
        AvailabilityZones: availabilityZones(ctx.region).map((z, i) => ({
          State: "available",
          RegionName: ctx.region,
          ZoneName: z,
          ZoneId: `${ctx.region.split("-")[0]}${ctx.region.split("-")[1].slice(0, 2)}${ctx.region.split("-")[2]}-az${i + 1}`,
          ZoneType: "availability-zone",
        })),
      };
    },
  }),

  // --- VPC ---
  cmd({
    service: "ec2",
    operation: "create-vpc",
    apiName: "CreateVpc",
    summary: "Create a VPC",
    usage: "--cidr-block <cidr> [--tag-specifications ResourceType=vpc,Tags=[{Key=Name,Value=<name>}]]",
    mutates: true,
    async run(args, ctx) {
      const r = await create(ctx, "networking", "vpc", { cidrBlock: args.required("cidr-block"), name: nameTag(args) });
      return { Vpc: present.vpc(r, pctx(ctx)) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-vpcs",
    apiName: "DescribeVpcs",
    summary: "List VPCs",
    usage: "[--vpc-ids <id> ...] [--filters Name=tag:Name,Values=<name>]",
    mutates: false,
    async run(args, ctx) {
      const items = await describe(ctx, args, { service: "networking", type: "vpc", idsOption: "vpc-ids", noun: "vpc" });
      return { Vpcs: items.map((r) => present.vpc(r, pctx(ctx))) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-vpc",
    apiName: "DeleteVpc",
    summary: "Delete a VPC",
    usage: "--vpc-id <id>",
    mutates: true,
    async run(args, ctx) {
      const r = await load(ctx, "networking", "vpc", args.required("vpc-id"), "vpc");
      await ctx.engine.remove(ctx.accountId, r.id);
    },
  }),

  // --- subnets ---
  cmd({
    service: "ec2",
    operation: "create-subnet",
    apiName: "CreateSubnet",
    summary: "Create a subnet in a VPC",
    usage: "--vpc-id <id> --cidr-block <cidr> [--availability-zone <az>]",
    mutates: true,
    async run(args, ctx) {
      const vpc = await load(ctx, "networking", "vpc", args.required("vpc-id"), "vpc");
      const r = await create(ctx, "networking", "subnet", {
        vpcId: vpc.id,
        cidrBlock: args.required("cidr-block"),
        availabilityZone: args.one("availability-zone") ?? availabilityZones(ctx.region)[0],
        name: nameTag(args),
      });
      return { Subnet: present.subnet(r, pctx(ctx)) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-subnets",
    apiName: "DescribeSubnets",
    summary: "List subnets",
    usage: "[--subnet-ids <id> ...] [--filters Name=vpc-id,Values=<id>]",
    mutates: false,
    async run(args, ctx) {
      const items = await describe(ctx, args, { service: "networking", type: "subnet", idsOption: "subnet-ids", noun: "subnet" });
      return { Subnets: items.map((r) => present.subnet(r, pctx(ctx))) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "modify-subnet-attribute",
    apiName: "ModifySubnetAttribute",
    summary: "Turn auto-assign public IP on or off",
    usage: "--subnet-id <id> --map-public-ip-on-launch | --no-map-public-ip-on-launch",
    mutates: true,
    async run(args, ctx) {
      const r = await load(ctx, "networking", "subnet", args.required("subnet-id"), "subnet");
      const value = args.bool("map-public-ip-on-launch");
      if (value === undefined) {
        throw new UsageError("one of --map-public-ip-on-launch or --no-map-public-ip-on-launch is required");
      }
      await ctx.engine.update(ctx.accountId, r.id, { mapPublicIpOnLaunch: value });
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-subnet",
    apiName: "DeleteSubnet",
    summary: "Delete a subnet",
    usage: "--subnet-id <id>",
    mutates: true,
    async run(args, ctx) {
      const r = await load(ctx, "networking", "subnet", args.required("subnet-id"), "subnet");
      await ctx.engine.remove(ctx.accountId, r.id);
    },
  }),

  // --- internet gateways ---
  cmd({
    service: "ec2",
    operation: "create-internet-gateway",
    apiName: "CreateInternetGateway",
    summary: "Create an internet gateway",
    mutates: true,
    async run(args, ctx) {
      const r = await create(ctx, "networking", "internet-gateway", { name: nameTag(args) });
      return { InternetGateway: present.internetGateway(r, pctx(ctx)) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "attach-internet-gateway",
    apiName: "AttachInternetGateway",
    summary: "Attach a gateway to a VPC",
    usage: "--internet-gateway-id <id> --vpc-id <id>",
    mutates: true,
    async run(args, ctx) {
      const igw = await load(ctx, "networking", "internet-gateway", args.required("internet-gateway-id"), "internetGateway");
      const vpc = await load(ctx, "networking", "vpc", args.required("vpc-id"), "vpc");
      await ctx.engine.update(ctx.accountId, igw.id, { vpcId: vpc.id });
    },
  }),
  cmd({
    service: "ec2",
    operation: "detach-internet-gateway",
    apiName: "DetachInternetGateway",
    summary: "Detach a gateway from a VPC",
    usage: "--internet-gateway-id <id> --vpc-id <id>",
    mutates: true,
    async run(args, ctx) {
      const igw = await load(ctx, "networking", "internet-gateway", args.required("internet-gateway-id"), "internetGateway");
      const vpcId = args.required("vpc-id");
      if (igw.config.vpcId !== vpcId) {
        throw new EngineError("Gateway.NotAttached", `resource ${igw.id} is not attached to network ${vpcId}`);
      }
      await ctx.engine.update(ctx.accountId, igw.id, { vpcId: null });
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-internet-gateways",
    apiName: "DescribeInternetGateways",
    summary: "List internet gateways",
    usage: "[--internet-gateway-ids <id> ...]",
    mutates: false,
    async run(args, ctx) {
      const items = await describe(ctx, args, {
        service: "networking",
        type: "internet-gateway",
        idsOption: "internet-gateway-ids",
        noun: "internetGateway",
      });
      return { InternetGateways: items.map((r) => present.internetGateway(r, pctx(ctx))) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-internet-gateway",
    apiName: "DeleteInternetGateway",
    summary: "Delete an internet gateway",
    usage: "--internet-gateway-id <id>",
    mutates: true,
    async run(args, ctx) {
      const igw = await load(ctx, "networking", "internet-gateway", args.required("internet-gateway-id"), "internetGateway");
      if (igw.config.vpcId) {
        throw new EngineError("DependencyViolation", `The internetGateway '${igw.id}' has dependencies and cannot be deleted.`, 409);
      }
      await ctx.engine.remove(ctx.accountId, igw.id);
    },
  }),

  // --- route tables ---
  cmd({
    service: "ec2",
    operation: "create-route-table",
    apiName: "CreateRouteTable",
    summary: "Create a route table in a VPC",
    usage: "--vpc-id <id>",
    mutates: true,
    async run(args, ctx) {
      const vpc = await load(ctx, "networking", "vpc", args.required("vpc-id"), "vpc");
      const r = await create(ctx, "networking", "route-table", { vpcId: vpc.id, name: nameTag(args) });
      return { RouteTable: await present.routeTable(r, pctx(ctx)) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "create-route",
    apiName: "CreateRoute",
    summary: "Add a route to a route table",
    usage: "--route-table-id <id> --destination-cidr-block <cidr> --gateway-id <igw-id>",
    mutates: true,
    async run(args, ctx) {
      const rt = await load(ctx, "networking", "route-table", args.required("route-table-id"), "routeTable");
      const destination = args.required("destination-cidr-block");
      const gatewayId = args.required("gateway-id");
      const routes = (rt.config.routes as { destination: string; gatewayId: string }[]) ?? [];
      await ctx.engine.update(ctx.accountId, rt.id, { routes: [...routes, { destination, gatewayId }] });
      return { Return: true };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-route",
    apiName: "DeleteRoute",
    summary: "Remove a route from a route table",
    usage: "--route-table-id <id> --destination-cidr-block <cidr>",
    mutates: true,
    async run(args, ctx) {
      const rt = await load(ctx, "networking", "route-table", args.required("route-table-id"), "routeTable");
      const destination = args.required("destination-cidr-block");
      const routes = (rt.config.routes as { destination: string; gatewayId: string }[]) ?? [];
      if (!routes.some((r) => r.destination === destination)) {
        throw new EngineError(
          "InvalidRoute.NotFound",
          `no route with destination-cidr-block ${destination} in route table ${rt.id}`,
          404,
        );
      }
      await ctx.engine.update(ctx.accountId, rt.id, { routes: routes.filter((r) => r.destination !== destination) });
    },
  }),
  cmd({
    service: "ec2",
    operation: "associate-route-table",
    apiName: "AssociateRouteTable",
    summary: "Make a subnet use a route table",
    usage: "--route-table-id <id> --subnet-id <id>",
    mutates: true,
    async run(args, ctx) {
      const rt = await load(ctx, "networking", "route-table", args.required("route-table-id"), "routeTable");
      const subnet = await load(ctx, "networking", "subnet", args.required("subnet-id"), "subnet");
      const subnetIds = (rt.config.subnetIds as string[]) ?? [];
      await ctx.engine.update(ctx.accountId, rt.id, { subnetIds: [...new Set([...subnetIds, subnet.id])] });
      return { AssociationId: present.associationId(subnet.id), AssociationState: { State: "associated" } };
    },
  }),
  cmd({
    service: "ec2",
    operation: "disassociate-route-table",
    apiName: "DisassociateRouteTable",
    summary: "Remove a subnet's route table association",
    usage: "--association-id <rtbassoc-id>",
    mutates: true,
    async run(args, ctx) {
      const assoc = args.required("association-id");
      const subnetId = `subnet-${assoc.replace(/^rtbassoc-/, "")}`;
      const rt = (await listOf(ctx, "networking", "route-table")).find((t) =>
        ((t.config.subnetIds as string[]) ?? []).includes(subnetId),
      );
      if (!rt) {
        throw new EngineError("InvalidAssociationID.NotFound", `The association ID '${assoc}' does not exist`, 404);
      }
      await ctx.engine.update(ctx.accountId, rt.id, {
        subnetIds: ((rt.config.subnetIds as string[]) ?? []).filter((s) => s !== subnetId),
      });
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-route-tables",
    apiName: "DescribeRouteTables",
    summary: "List route tables",
    usage: "[--route-table-ids <id> ...] [--filters Name=vpc-id,Values=<id>]",
    mutates: false,
    async run(args, ctx) {
      const items = await describe(ctx, args, {
        service: "networking",
        type: "route-table",
        idsOption: "route-table-ids",
        noun: "routeTable",
      });
      return { RouteTables: await Promise.all(items.map((r) => present.routeTable(r, pctx(ctx)))) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-route-table",
    apiName: "DeleteRouteTable",
    summary: "Delete a route table",
    usage: "--route-table-id <id>",
    mutates: true,
    async run(args, ctx) {
      const rt = await load(ctx, "networking", "route-table", args.required("route-table-id"), "routeTable");
      if (((rt.config.subnetIds as string[]) ?? []).length > 0) {
        throw new EngineError(
          "DependencyViolation",
          `The routeTable '${rt.id}' has dependencies and cannot be deleted. Disassociate its subnets first.`,
          409,
        );
      }
      await ctx.engine.remove(ctx.accountId, rt.id);
    },
  }),

  // --- security groups ---
  cmd({
    service: "ec2",
    operation: "create-security-group",
    apiName: "CreateSecurityGroup",
    summary: "Create a security group",
    usage: "--group-name <name> --description <text> --vpc-id <id>",
    mutates: true,
    async run(args, ctx) {
      const vpcId = args.one("vpc-id");
      if (!vpcId) {
        throw new EngineError("VPCIdNotSpecified", "No default VPC for this user. Pass --vpc-id.");
      }
      const vpc = await load(ctx, "networking", "vpc", vpcId, "vpc");
      const r = await create(ctx, "networking", "security-group", {
        name: args.required("group-name"),
        description: args.required("description"),
        vpcId: vpc.id,
      });
      return { GroupId: r.id };
    },
  }),
  cmd({
    service: "ec2",
    operation: "authorize-security-group-ingress",
    apiName: "AuthorizeSecurityGroupIngress",
    summary: "Allow inbound traffic",
    usage: "--group-id <id> --protocol tcp|udp|icmp|all --port <port|from-to> --cidr <cidr>",
    mutates: true,
    async run(args, ctx) {
      const sg = await load(ctx, "networking", "security-group", args.required("group-id"), "security group");
      const rule = ruleFromArgs(args);
      const rules = (sg.config.inboundRules as Rule[]) ?? [];
      if (rules.some((r) => sameRule(r, rule))) {
        throw new EngineError(
          "InvalidPermission.Duplicate",
          `the specified rule "peer: ${rule.cidr}, ${rule.protocol.toUpperCase()}, from port: ${rule.fromPort ?? "all"}, to port: ${rule.toPort ?? "all"}, ALLOW" already exists`,
          409,
        );
      }
      await ctx.engine.update(ctx.accountId, sg.id, { inboundRules: [...rules, rule] });
      return { Return: true };
    },
  }),
  cmd({
    service: "ec2",
    operation: "revoke-security-group-ingress",
    apiName: "RevokeSecurityGroupIngress",
    summary: "Remove an inbound rule",
    usage: "--group-id <id> --protocol tcp|udp|icmp|all --port <port|from-to> --cidr <cidr>",
    mutates: true,
    async run(args, ctx) {
      const sg = await load(ctx, "networking", "security-group", args.required("group-id"), "security group");
      const rule = ruleFromArgs(args);
      const rules = (sg.config.inboundRules as Rule[]) ?? [];
      if (!rules.some((r) => sameRule(r, rule))) {
        throw new EngineError(
          "InvalidPermission.NotFound",
          "The specified rule does not exist in this security group.",
          404,
        );
      }
      await ctx.engine.update(ctx.accountId, sg.id, { inboundRules: rules.filter((r) => !sameRule(r, rule)) });
      return { Return: true };
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-security-groups",
    apiName: "DescribeSecurityGroups",
    summary: "List security groups",
    usage: "[--group-ids <id> ...] [--filters Name=vpc-id,Values=<id>]",
    mutates: false,
    async run(args, ctx) {
      const items = await describe(ctx, args, {
        service: "networking",
        type: "security-group",
        idsOption: "group-ids",
        noun: "security group",
      });
      return { SecurityGroups: items.map((r) => present.securityGroup(r, pctx(ctx))) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-security-group",
    apiName: "DeleteSecurityGroup",
    summary: "Delete a security group",
    usage: "--group-id <id>",
    mutates: true,
    async run(args, ctx) {
      const sg = await load(ctx, "networking", "security-group", args.required("group-id"), "security group");
      await ctx.engine.remove(ctx.accountId, sg.id);
    },
  }),

  // --- instances ---
  cmd({
    service: "ec2",
    operation: "run-instances",
    apiName: "RunInstances",
    summary: "Launch instances",
    usage:
      "--image-id <ami> --subnet-id <id> --security-group-ids <id> ... [--instance-type t3.micro] [--count 1] [--key-name <name>] [--associate-public-ip-address | --no-associate-public-ip-address]",
    mutates: true,
    async run(args, ctx) {
      const imageId = args.required("image-id");
      const subnetId = args.one("subnet-id");
      if (!subnetId) {
        throw new EngineError("VPCIdNotSpecified", "No default VPC for this user. Pass --subnet-id.");
      }
      const groups = args.list("security-group-ids");
      if (groups.length === 0) {
        throw new EngineError(
          "MissingParameter",
          "CloudLab needs --security-group-ids (default security groups aren't simulated yet).",
        );
      }
      const count = Number(args.one("count") ?? "1");
      if (!Number.isInteger(count) || count < 1 || count > 10) {
        throw new EngineError("InvalidParameterValue", "--count must be between 1 and 10 in CloudLab.");
      }
      const pub = args.bool("associate-public-ip-address");
      const instances = [];
      for (let i = 0; i < count; i++) {
        instances.push(
          await create(ctx, "compute", "instance", {
            imageId,
            instanceType: args.one("instance-type") ?? "t3.micro",
            subnetId,
            securityGroupIds: groups,
            keyName: args.one("key-name"),
            associatePublicIp: pub === undefined ? "subnet-default" : pub ? "enable" : "disable",
            name: nameTag(args),
          }),
        );
      }
      return {
        Groups: [],
        Instances: await Promise.all(instances.map((r) => present.instance(r, pctx(ctx)))),
        OwnerId: present.ownerId(ctx.accountId),
        ReservationId: present.reservationId(instances[0].id),
      };
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-instances",
    apiName: "DescribeInstances",
    summary: "List instances",
    usage: "[--instance-ids <id> ...] [--filters Name=instance-state-name,Values=running]",
    mutates: false,
    async run(args, ctx) {
      const items = await describe(ctx, args, { service: "compute", type: "instance", idsOption: "instance-ids", noun: "instance" });
      return { Reservations: await Promise.all(items.map((r) => present.reservation(r, pctx(ctx)))) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "start-instances",
    apiName: "StartInstances",
    summary: "Start stopped instances",
    usage: "--instance-ids <id> ...",
    mutates: true,
    async run(args, ctx) {
      return { StartingInstances: await instanceAction(ctx, args, "start") };
    },
  }),
  cmd({
    service: "ec2",
    operation: "stop-instances",
    apiName: "StopInstances",
    summary: "Stop running instances",
    usage: "--instance-ids <id> ...",
    mutates: true,
    async run(args, ctx) {
      return { StoppingInstances: await instanceAction(ctx, args, "stop") };
    },
  }),
  cmd({
    service: "ec2",
    operation: "reboot-instances",
    apiName: "RebootInstances",
    summary: "Reboot running instances",
    usage: "--instance-ids <id> ...",
    mutates: true,
    async run(args, ctx) {
      await instanceAction(ctx, args, "reboot");
    },
  }),
  cmd({
    service: "ec2",
    operation: "terminate-instances",
    apiName: "TerminateInstances",
    summary: "Terminate instances",
    usage: "--instance-ids <id> ...",
    mutates: true,
    async run(args, ctx) {
      return { TerminatingInstances: await instanceAction(ctx, args, "terminate") };
    },
  }),
  cmd({
    service: "ec2",
    operation: "modify-instance-attribute",
    apiName: "ModifyInstanceAttribute",
    summary: "Change instance type (instance must be stopped)",
    usage: "--instance-id <id> --instance-type <type>",
    mutates: true,
    async run(args, ctx) {
      const r = await load(ctx, "compute", "instance", args.required("instance-id"), "instance");
      const raw = args.required("instance-type");
      const value = raw.startsWith("{") ? String(parseShorthand(raw).Value) : raw.replace(/^Value=/, "");
      await ctx.engine.update(ctx.accountId, r.id, { instanceType: value });
    },
  }),

  // --- S3 (high-level) ---
  cmd({
    service: "s3",
    operation: "mb",
    apiName: "CreateBucket",
    summary: "Make a bucket",
    usage: "s3://<bucket>",
    mutates: true,
    async run(args, ctx) {
      const name = bucketFromUri(args.positionals[0]);
      await create(ctx, "storage", "bucket", { name });
      return `make_bucket: ${name}`;
    },
  }),
  cmd({
    service: "s3",
    operation: "rb",
    apiName: "DeleteBucket",
    summary: "Remove a bucket",
    usage: "s3://<bucket>",
    mutates: true,
    async run(args, ctx) {
      const name = bucketFromUri(args.positionals[0]);
      await loadBucket(ctx, name);
      await ctx.engine.remove(ctx.accountId, name);
      return `remove_bucket: ${name}`;
    },
  }),
  cmd({
    service: "s3",
    operation: "ls",
    apiName: "ListBuckets",
    summary: "List buckets",
    mutates: false,
    async run(_args, ctx) {
      const buckets = await ctx.engine.list(ctx.accountId, { service: "storage", type: "bucket" });
      return buckets
        .map((b) => `${b.createdAt.slice(0, 19).replace("T", " ")} ${b.id}`)
        .join("\n");
    },
  }),

  // --- S3 API ---
  cmd({
    service: "s3api",
    operation: "create-bucket",
    apiName: "CreateBucket",
    summary: "Create a bucket",
    usage: "--bucket <name>",
    mutates: true,
    async run(args, ctx) {
      const name = args.required("bucket");
      await create(ctx, "storage", "bucket", { name });
      return { Location: `/${name}` };
    },
  }),
  cmd({
    service: "s3api",
    operation: "list-buckets",
    apiName: "ListBuckets",
    summary: "List buckets",
    mutates: false,
    async run(_args, ctx) {
      const buckets = await ctx.engine.list(ctx.accountId, { service: "storage", type: "bucket" });
      return {
        Buckets: buckets.map((b) => ({ Name: b.id, CreationDate: b.createdAt })),
        Owner: { ID: present.ownerId(ctx.accountId) },
      };
    },
  }),
  cmd({
    service: "s3api",
    operation: "delete-bucket",
    apiName: "DeleteBucket",
    summary: "Delete a bucket",
    usage: "--bucket <name>",
    mutates: true,
    async run(args, ctx) {
      const b = await loadBucket(ctx, args.required("bucket"));
      await ctx.engine.remove(ctx.accountId, b.id);
    },
  }),
  cmd({
    service: "s3api",
    operation: "put-bucket-versioning",
    apiName: "PutBucketVersioning",
    summary: "Enable or suspend versioning",
    usage: "--bucket <name> --versioning-configuration Status=Enabled|Suspended",
    mutates: true,
    async run(args, ctx) {
      const b = await loadBucket(ctx, args.required("bucket"));
      const status = String(parseShorthand(args.required("versioning-configuration")).Status ?? "");
      if (status !== "Enabled" && status !== "Suspended") {
        throw new EngineError("MalformedXML", "Status must be Enabled or Suspended.");
      }
      await ctx.engine.update(ctx.accountId, b.id, { versioning: status });
    },
  }),
  cmd({
    service: "s3api",
    operation: "get-bucket-versioning",
    apiName: "GetBucketVersioning",
    summary: "Show a bucket's versioning status",
    usage: "--bucket <name>",
    mutates: false,
    async run(args, ctx) {
      const b = await loadBucket(ctx, args.required("bucket"));
      return b.config.versioning === "Disabled" ? {} : { Status: b.config.versioning };
    },
  }),
];

export function findCommand(service: string, operation: string) {
  return COMMANDS.find((c) => c.service === service && c.operation === operation);
}

export function servicesList() {
  return [...new Set(COMMANDS.map((c) => c.service))];
}
