import { REGIONS, availabilityZones } from "@/engine/catalog";
import type { Engine } from "@/engine/engine";
import { EngineError } from "@/engine/errors";
import { systemOf, type Resource } from "@/engine/types";
import { parseShorthand, UsageError } from "./parse";
import * as present from "./present";
import { S3_COMMANDS } from "./s3";

export interface CliContext {
  engine: Engine;
  accountId: string;
  region: string;
  /** Local files the terminal sent along with the command (name as typed → base64 contents). */
  files?: Record<string, string>;
  /** Side channel for what a command wants to happen besides printing output. */
  effects?: CliEffects;
}

export interface CliEffects {
  /** A file for the browser to save, e.g. from `aws s3 cp s3://bucket/key .`. */
  download?: { filename: string; data: string; contentType: string };
  /** The API operation actually called, when it depends on the arguments (cp: PutObject or GetObject). */
  apiName?: string;
  /** Text the real CLI prints before an error, e.g. "upload failed: index.html to s3://b/index.html ". */
  failurePrefix?: string;
  failureExitCode?: number;
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

/** Loads a resource of a given type in the current region, failing exactly as the real API would. */
function load(ctx: CliContext, service: string, type: string, id: string): Promise<Resource> {
  return ctx.engine.getTyped(ctx.accountId, id, service, type, ctx.region);
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
  // Most commands take --filters; a few (describe-nat-gateways) take --filter.
  return [...args.raw("filters"), ...args.raw("filter")].reduce((acc, raw) => {
    const f = parseShorthand(raw);
    const name = String(f.Name ?? "");
    const values = ([] as string[]).concat(f.Values ?? []);
    const pick = (r: Resource): unknown => {
      if (name === "vpc-id") return r.config.vpcId ?? r.attributes.vpcId;
      if (name === "route.nat-gateway-id") {
        return ((r.config.routes as { natGatewayId?: string }[]) ?? []).map((x) => x.natGatewayId).find((id) => values.includes(String(id)));
      }
      if (name === "subnet-id") return r.config.subnetId;
      if (name === "instance-state-name" || name === "state") return r.state;
      if (name === "availability-zone") return r.config.availabilityZone ?? r.attributes.availabilityZone;
      if (name === "tag:Name") return r.name;
      if (name === "group-name") return r.config.name;
      if (name === "isDefault" || name === "is-default") return String(systemOf(r).isDefault === true);
      if (name === "default-for-az" || name === "defaultForAz") return String(systemOf(r).defaultForAz === true);
      if (name === "association.main") return String(systemOf(r).main === true);
      if (name === "internet-gateway-id" || name === "nat-gateway-id") return r.id;
      if (name === "attachment.vpc-id") return r.config.vpcId;
      if (name === "key-name") return r.type === "key-pair" ? r.name : r.config.keyName;
      if (name === "key-pair-id" || name === "allocation-id") return r.id;
      if (name === "fingerprint") return r.attributes.fingerprint;
      if (name === "key-type") return r.config.keyType;
      if (name === "instance-id") return r.config.instanceId ?? (r.type === "instance" ? r.id : undefined);
      if (name === "public-ip") return r.attributes.publicIp;
      if (name === "association-id") return r.attributes.associationId;
      if (name === "domain") return "vpc";
      if (name === "ip-address") return r.attributes.publicIp;
      throw new EngineError("InvalidParameterValue", `The filter '${name}' is invalid`);
    };
    return acc.filter((r) => values.includes(String(pick(r))));
  }, items);
}

async function describe(ctx: CliContext, args: Args, opts: { service: string; type: string; idsOption: string }) {
  const ids = args.list(opts.idsOption);
  const items = ids.length
    ? await Promise.all(ids.map((id) => load(ctx, opts.service, opts.type, id)))
    : await listOf(ctx, opts.service, opts.type);
  return applyFilters(args, items);
}

const pctx = (ctx: CliContext): present.PresentContext => ({ engine: ctx.engine, accountId: ctx.accountId });

interface Rule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidr?: string;
  sourceGroupId?: string;
  description?: string;
}

/** Reads --protocol/--port/--cidr into a security group rule. */
function ruleFromArgs(args: Args): Rule {
  let protocol = args.required("protocol").toLowerCase();
  if (protocol === "-1") protocol = "all";
  if (!["tcp", "udp", "icmp", "all"].includes(protocol)) {
    throw new EngineError("InvalidParameterValue", `Invalid value '${protocol}' for IP protocol. Unknown protocol.`);
  }
  const cidr = args.one("cidr");
  const sourceGroupId = args.one("source-group");
  if (cidr && sourceGroupId) throw new UsageError("--cidr and --source-group cannot be used together; add them as two rules");
  if (!cidr && !sourceGroupId) {
    throw new EngineError("MissingParameter", "Either --cidr or --source-group must be specified.");
  }
  const source = cidr ? { cidr } : { sourceGroupId };
  if (protocol !== "tcp" && protocol !== "udp") return { protocol, ...source };
  const port = args.required("port");
  const [from, to = from] = port.split("-");
  const fromPort = Number(from);
  const toPort = Number(to);
  if (!Number.isInteger(fromPort) || !Number.isInteger(toPort)) {
    throw new EngineError("InvalidParameterValue", `Invalid value '${port}' for portRange. Must specify both from and to ports with TCP/UDP.`);
  }
  return { protocol, fromPort, toPort, ...source };
}

const sameRule = (a: Rule, b: Rule) =>
  a.protocol === b.protocol &&
  (a.cidr ?? "") === (b.cidr ?? "") &&
  (a.sourceGroupId ?? "") === (b.sourceGroupId ?? "") &&
  (a.fromPort ?? -1) === (b.fromPort ?? -1) &&
  (a.toPort ?? -1) === (b.toPort ?? -1);

/** The default VPC's subnet in the first availability zone, used when no subnet is given. */
async function defaultSubnet(ctx: CliContext): Promise<Resource | undefined> {
  const vpc = await ctx.engine.defaultVpc(ctx.accountId, ctx.region);
  if (!vpc) return undefined;
  const subnets = (await listOf(ctx, "networking", "subnet")).filter(
    (s) => s.config.vpcId === vpc.id && systemOf(s).defaultForAz,
  );
  return subnets.sort((a, b) => String(a.config.availabilityZone).localeCompare(String(b.config.availabilityZone)))[0];
}

/** A VPC's "default" security group. */
async function defaultGroup(ctx: CliContext, vpcId: string): Promise<Resource | undefined> {
  return (await listOf(ctx, "networking", "security-group")).find((g) => g.config.vpcId === vpcId && systemOf(g).isDefault);
}

/** Runs a lifecycle action on several instances and reports state changes like the real API. */
async function instanceAction(ctx: CliContext, args: Args, action: string) {
  const ids = args.list("instance-ids");
  if (ids.length === 0) throw new UsageError("the following arguments are required: --instance-ids");
  const changes = [];
  for (const id of ids) {
    const before = await load(ctx, "compute", "instance", id);
    const after = await ctx.engine.runAction(ctx.accountId, id, action);
    changes.push({
      CurrentState: present.instanceState(after.state),
      InstanceId: id,
      PreviousState: present.instanceState(before.state),
    });
  }
  return changes;
}

/** A key pair by name, failing like the real API. */
async function keyPairByName(ctx: CliContext, name: string): Promise<Resource> {
  const found = (await listOf(ctx, "compute", "key-pair")).find((k) => k.name === name);
  if (!found) throw new EngineError("InvalidKeyPair.NotFound", `The key pair '${name}' does not exist`);
  return found;
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
      const cidrBlock = args.one("cidr-block");
      if (!cidrBlock) {
        throw new EngineError("MissingParameter", "Either 'cidrBlock' or 'ipv4IpamPoolId' should be provided.");
      }
      const r = await create(ctx, "networking", "vpc", { cidrBlock, name: nameTag(args) });
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
      const items = await describe(ctx, args, { service: "networking", type: "vpc", idsOption: "vpc-ids" });
      return { Vpcs: items.map((r) => present.vpc(r, pctx(ctx))) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "create-default-vpc",
    apiName: "CreateDefaultVpc",
    summary: "Recreate the region's default VPC",
    mutates: true,
    async run(_args, ctx) {
      const r = await ctx.engine.createDefaultVpc(ctx.accountId, ctx.region);
      return { Vpc: present.vpc(r, pctx(ctx)) };
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
      const r = await load(ctx, "networking", "vpc", args.required("vpc-id"));
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
      const vpc = await load(ctx, "networking", "vpc", args.required("vpc-id"));
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
      const items = await describe(ctx, args, { service: "networking", type: "subnet", idsOption: "subnet-ids" });
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
      const r = await load(ctx, "networking", "subnet", args.required("subnet-id"));
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
      const r = await load(ctx, "networking", "subnet", args.required("subnet-id"));
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
      const igw = await load(ctx, "networking", "internet-gateway", args.required("internet-gateway-id"));
      const vpc = await load(ctx, "networking", "vpc", args.required("vpc-id"));
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
      const igw = await load(ctx, "networking", "internet-gateway", args.required("internet-gateway-id"));
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
      const igw = await load(ctx, "networking", "internet-gateway", args.required("internet-gateway-id"));
      await ctx.engine.remove(ctx.accountId, igw.id);
    },
  }),

  // --- NAT gateways ---
  cmd({
    service: "ec2",
    operation: "create-nat-gateway",
    apiName: "CreateNatGateway",
    summary: "Create a NAT gateway in a public subnet",
    usage: "--subnet-id <id> --allocation-id <eipalloc-id> [--connectivity-type public]",
    mutates: true,
    async run(args, ctx) {
      const type = args.one("connectivity-type") ?? "public";
      if (type !== "public") {
        throw new EngineError("InvalidParameterValue", `Value (${type}) for parameter connectivityType is invalid. CloudLab supports public.`);
      }
      const subnet = await load(ctx, "networking", "subnet", args.required("subnet-id"));
      const allocationId = args.one("allocation-id");
      if (!allocationId) {
        throw new EngineError("MissingParameter", "AllocationId is required for a public NAT gateway.");
      }
      const r = await create(ctx, "networking", "nat-gateway", { subnetId: subnet.id, allocationId, name: nameTag(args) });
      return { NatGateway: present.natGateway(r) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-nat-gateways",
    apiName: "DescribeNatGateways",
    summary: "List NAT gateways",
    usage: "[--nat-gateway-ids <id> ...] [--filter Name=vpc-id,Values=<id>]",
    mutates: false,
    async run(args, ctx) {
      const items = await describe(ctx, args, { service: "networking", type: "nat-gateway", idsOption: "nat-gateway-ids" });
      return { NatGateways: items.map((r) => present.natGateway(r)) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-nat-gateway",
    apiName: "DeleteNatGateway",
    summary: "Delete a NAT gateway (its Elastic IP is kept)",
    usage: "--nat-gateway-id <id>",
    mutates: true,
    async run(args, ctx) {
      const nat = await load(ctx, "networking", "nat-gateway", args.required("nat-gateway-id"));
      await ctx.engine.remove(ctx.accountId, nat.id);
      return { NatGatewayId: nat.id };
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
      const vpc = await load(ctx, "networking", "vpc", args.required("vpc-id"));
      const r = await create(ctx, "networking", "route-table", { vpcId: vpc.id, name: nameTag(args) });
      return { RouteTable: await present.routeTable(r, pctx(ctx)) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "create-route",
    apiName: "CreateRoute",
    summary: "Add a route to a route table",
    usage: "--route-table-id <id> --destination-cidr-block <cidr> (--gateway-id <igw-id> | --nat-gateway-id <nat-id>)",
    mutates: true,
    async run(args, ctx) {
      const rt = await load(ctx, "networking", "route-table", args.required("route-table-id"));
      const destination = args.required("destination-cidr-block");
      const gatewayId = args.one("gateway-id");
      const natGatewayId = args.one("nat-gateway-id");
      const routes = (rt.config.routes as Record<string, unknown>[]) ?? [];
      const route = { destination, ...(gatewayId ? { gatewayId } : {}), ...(natGatewayId ? { natGatewayId } : {}) };
      await ctx.engine.update(ctx.accountId, rt.id, { routes: [...routes, route] });
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
      const rt = await load(ctx, "networking", "route-table", args.required("route-table-id"));
      const destination = args.required("destination-cidr-block");
      const routes = (rt.config.routes as { destination: string }[]) ?? [];
      if (!routes.some((r) => r.destination === destination)) {
        throw new EngineError("InvalidRoute.NotFound", `no route with destination-cidr-block ${destination} in route table ${rt.id}`);
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
      const rt = await load(ctx, "networking", "route-table", args.required("route-table-id"));
      const subnet = await load(ctx, "networking", "subnet", args.required("subnet-id"));
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
        throw new EngineError("InvalidAssociationID.NotFound", `The association ID '${assoc}' does not exist`);
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
      const rt = await load(ctx, "networking", "route-table", args.required("route-table-id"));
      await ctx.engine.remove(ctx.accountId, rt.id);
    },
  }),

  // --- security groups ---
  cmd({
    service: "ec2",
    operation: "create-security-group",
    apiName: "CreateSecurityGroup",
    summary: "Create a security group",
    usage: "--group-name <name> --description <text> [--vpc-id <id>]",
    mutates: true,
    async run(args, ctx) {
      // Without --vpc-id the group goes into the default VPC, if there is one.
      const vpcId = args.one("vpc-id") ?? (await ctx.engine.defaultVpc(ctx.accountId, ctx.region))?.id;
      if (!vpcId) {
        throw new EngineError("VPCIdNotSpecified", "No default VPC for this user");
      }
      const vpc = await load(ctx, "networking", "vpc", vpcId);
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
    usage: "--group-id <id> --protocol tcp|udp|icmp|all --port <port|from-to> (--cidr <cidr> | --source-group <sg-id>)",
    mutates: true,
    async run(args, ctx) {
      const sg = await load(ctx, "networking", "security-group", args.required("group-id"));
      const rule = ruleFromArgs(args);
      const rules = (sg.config.inboundRules as Rule[]) ?? [];
      if (rules.some((r) => sameRule(r, rule))) {
        throw new EngineError(
          "InvalidPermission.Duplicate",
          `the specified rule "peer: ${rule.cidr ?? rule.sourceGroupId}, ${rule.protocol === "all" ? "ALL" : rule.protocol.toUpperCase()}, ${rule.fromPort === undefined ? "ALL PORTS" : `from port: ${rule.fromPort}, to port: ${rule.toPort}`}, ALLOW" already exists`,
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
    usage: "--group-id <id> --protocol tcp|udp|icmp|all --port <port|from-to> (--cidr <cidr> | --source-group <sg-id>)",
    mutates: true,
    async run(args, ctx) {
      const sg = await load(ctx, "networking", "security-group", args.required("group-id"));
      const rule = ruleFromArgs(args);
      const rules = (sg.config.inboundRules as Rule[]) ?? [];
      if (!rules.some((r) => sameRule(r, rule))) {
        throw new EngineError("InvalidPermission.NotFound", "The specified rule does not exist in this security group.");
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
      const sg = await load(ctx, "networking", "security-group", args.required("group-id"));
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
      "--image-id <ami> [--subnet-id <id>] [--security-group-ids <id> ...] [--instance-type t3.micro] [--count 1] [--key-name <name>] [--associate-public-ip-address | --no-associate-public-ip-address]",
    mutates: true,
    async run(args, ctx) {
      const imageId = args.one("image-id");
      // Like the real API: no subnet means the default VPC's default subnet,
      // and no security groups means the VPC's "default" group.
      const subnetId = args.one("subnet-id") ?? (await defaultSubnet(ctx))?.id;
      if (!subnetId) {
        throw new EngineError(
          "VPCIdNotSpecified",
          "No default VPC for this user. GroupName is only supported for EC2-Classic and default VPC.",
        );
      }
      let groups = args.list("security-group-ids");
      if (groups.length === 0) {
        const subnet = await load(ctx, "networking", "subnet", subnetId);
        const fallback = await defaultGroup(ctx, subnet.config.vpcId as string);
        if (fallback) groups = [fallback.id];
      }
      const count = Number(args.one("count") ?? "1");
      if (!Number.isInteger(count) || count < 1 || count > 10) {
        throw new EngineError("InvalidParameterValue", `Value (${args.one("count")}) for parameter maxCount is invalid. CloudLab allows 1 to 10.`);
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
      const items = await describe(ctx, args, { service: "compute", type: "instance", idsOption: "instance-ids" });
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
      const r = await load(ctx, "compute", "instance", args.required("instance-id"));
      const raw = args.required("instance-type");
      const value = raw.startsWith("{") ? String(parseShorthand(raw).Value) : raw.replace(/^Value=/, "");
      await ctx.engine.update(ctx.accountId, r.id, { instanceType: value });
    },
  }),

  // --- key pairs ---
  cmd({
    service: "ec2",
    operation: "create-key-pair",
    apiName: "CreateKeyPair",
    summary: "Create a key pair and print its private key (shown only once)",
    usage: "--key-name <name> [--key-type rsa|ed25519] [--key-format pem]",
    mutates: true,
    async run(args, ctx) {
      const format = args.one("key-format") ?? "pem";
      if (format !== "pem") {
        throw new EngineError("InvalidParameterValue", `Value (${format}) for parameter keyFormat is invalid. CloudLab supports pem.`);
      }
      const r = await create(ctx, "compute", "key-pair", {
        name: args.required("key-name"),
        keyType: args.one("key-type") ?? "rsa",
      });
      return {
        KeyFingerprint: r.attributes.fingerprint,
        KeyMaterial: r.attributes.keyMaterial,
        KeyName: r.name,
        KeyPairId: r.id,
      };
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-key-pairs",
    apiName: "DescribeKeyPairs",
    summary: "List key pairs",
    usage: "[--key-names <name> ...] [--key-pair-ids <id> ...] [--include-public-key]",
    mutates: false,
    async run(args, ctx) {
      const names = args.list("key-names");
      let items = names.length
        ? await Promise.all(names.map((n) => keyPairByName(ctx, n)))
        : await describe(ctx, args, { service: "compute", type: "key-pair", idsOption: "key-pair-ids" });
      if (names.length) items = applyFilters(args, items);
      return { KeyPairs: items.map((r) => present.keyPair(r, { includePublicKey: args.has("include-public-key") })) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-key-pair",
    apiName: "DeleteKeyPair",
    summary: "Delete a key pair (instances using it keep working)",
    usage: "--key-name <name> | --key-pair-id <id>",
    mutates: true,
    async run(args, ctx) {
      const id = args.one("key-pair-id");
      const name = args.one("key-name");
      if (!id && !name) throw new EngineError("MissingParameter", "The request must contain the parameter KeyName or KeyPairId");
      // Like the real API, deleting a key name that doesn't exist succeeds quietly.
      const r = id
        ? await load(ctx, "compute", "key-pair", id)
        : (await listOf(ctx, "compute", "key-pair")).find((k) => k.name === name);
      if (!r) return { Return: true };
      await ctx.engine.remove(ctx.accountId, r.id);
      return { Return: true, KeyPairId: r.id };
    },
  }),

  // --- Elastic IPs ---
  cmd({
    service: "ec2",
    operation: "allocate-address",
    apiName: "AllocateAddress",
    summary: "Allocate an Elastic IP address",
    usage: "[--domain vpc]",
    mutates: true,
    async run(args, ctx) {
      const domain = args.one("domain") ?? "vpc";
      if (domain !== "vpc") {
        throw new EngineError("InvalidParameterValue", `Value (${domain}) for parameter domain is invalid. Must be 'vpc'.`);
      }
      const r = await create(ctx, "compute", "elastic-ip", { name: nameTag(args) });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { Tags, ...out } = present.address(r);
      return out;
    },
  }),
  cmd({
    service: "ec2",
    operation: "associate-address",
    apiName: "AssociateAddress",
    summary: "Attach an Elastic IP to an instance",
    usage: "--allocation-id <eipalloc-id> --instance-id <id> [--allow-reassociation | --no-allow-reassociation]",
    mutates: true,
    async run(args, ctx) {
      const instanceId = args.one("instance-id");
      if (!instanceId) {
        throw new EngineError("MissingParameter", "Either the instanceId or the networkInterfaceId parameter must be specified.");
      }
      const allocationId = args.one("allocation-id");
      if (!allocationId) throw new EngineError("MissingParameter", "The request must contain the parameter AllocationId");
      const eip = await load(ctx, "compute", "elastic-ip", allocationId);
      const target = await load(ctx, "compute", "instance", instanceId);
      const current = eip.config.instanceId as string | undefined;
      if (current === target.id) return { AssociationId: eip.attributes.associationId };
      // --allow-reassociation moves an address that is attached elsewhere.
      if (current && args.bool("allow-reassociation")) {
        await ctx.engine.update(ctx.accountId, eip.id, { instanceId: null });
      }
      const updated = await ctx.engine.update(ctx.accountId, eip.id, { instanceId: target.id });
      return { AssociationId: updated.attributes.associationId };
    },
  }),
  cmd({
    service: "ec2",
    operation: "disassociate-address",
    apiName: "DisassociateAddress",
    summary: "Detach an Elastic IP from its instance",
    usage: "--association-id <eipassoc-id>",
    mutates: true,
    async run(args, ctx) {
      const assoc = args.required("association-id");
      if (!/^eipassoc-[0-9a-f]{8,17}$/.test(assoc)) {
        throw new EngineError("InvalidAssociationID.Malformed", `Invalid id: "${assoc}" (expecting "eipassoc-...")`);
      }
      const eip = (await listOf(ctx, "compute", "elastic-ip")).find((a) => a.attributes.associationId === assoc);
      if (!eip) throw new EngineError("InvalidAssociationID.NotFound", `The association ID '${assoc}' does not exist`);
      await ctx.engine.update(ctx.accountId, eip.id, { instanceId: null });
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-addresses",
    apiName: "DescribeAddresses",
    summary: "List Elastic IP addresses",
    usage: "[--allocation-ids <id> ...] [--public-ips <ip> ...] [--filters Name=instance-id,Values=<id>]",
    mutates: false,
    async run(args, ctx) {
      let items = await describe(ctx, args, { service: "compute", type: "elastic-ip", idsOption: "allocation-ids" });
      for (const ip of args.list("public-ips")) {
        if (!items.some((a) => a.attributes.publicIp === ip)) {
          throw new EngineError("InvalidAddress.NotFound", `Address '${ip}' not found.`);
        }
      }
      if (args.list("public-ips").length) items = items.filter((a) => args.list("public-ips").includes(String(a.attributes.publicIp)));
      return { Addresses: items.map((r) => present.address(r)) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "release-address",
    apiName: "ReleaseAddress",
    summary: "Give an Elastic IP back",
    usage: "--allocation-id <eipalloc-id>",
    mutates: true,
    async run(args, ctx) {
      const eip = await load(ctx, "compute", "elastic-ip", args.required("allocation-id"));
      await ctx.engine.remove(ctx.accountId, eip.id);
    },
  }),

  // --- S3 (buckets, objects, websites) ---
  ...S3_COMMANDS,
];

export function findCommand(service: string, operation: string) {
  return COMMANDS.find((c) => c.service === service && c.operation === operation);
}

export function servicesList() {
  return [...new Set(COMMANDS.map((c) => c.service))];
}
