import { cidrContains, parseCidr } from "../cidr";
import { ec2Arn } from "../iam/arns";
import { EngineError } from "../errors";
import { generateId } from "../ids";
import { systemOf, type ResourceTypeDef } from "../types";
import { nextPrivateIp } from "./ips";

/** A route's target: an internet gateway or a NAT gateway. */
export interface Route {
  destination: string;
  gatewayId?: string;
  natGatewayId?: string;
}

export const routeTarget = (r: Route) => r.gatewayId || r.natGatewayId || "";

/**
 * Internet gateways and route tables. Together with subnets and security
 * groups they decide whether an instance can actually be reached.
 */

export const internetGateway: ResourceTypeDef = {
  service: "networking",
  type: "internet-gateway",
  label: "Internet gateway",
  pluralLabel: "Internet gateways",
  description:
    "Connects a VPC to the internet. Attach it to a VPC, then add a route to it in a route table.",
  idPrefix: "igw",
  notFoundCode: "InvalidInternetGatewayID.NotFound",
  apiNoun: "internetGateway",
  iam: {
    create: "ec2:CreateInternetGateway",
    read: "ec2:DescribeInternetGateways",
    update: (changed) => (changed.includes("vpcId") ? ["ec2:AttachInternetGateway"] : ["ec2:CreateTags"]),
    delete: "ec2:DeleteInternetGateway",
    arn: ec2Arn("internet-gateway"),
  },
  canDelete: (igw) =>
    igw.config.vpcId
      ? new EngineError("DependencyViolation", `The internetGateway '${igw.id}' has dependencies and cannot be deleted.`)
      : undefined,
  fields: [
    { key: "name", label: "Name tag", type: "string", maxLength: 255, placeholder: "main-igw" },
    {
      key: "vpcId",
      label: "Attached VPC",
      type: "ref",
      ref: { service: "networking", type: "vpc" },
      description: "Choose a VPC to attach, or None to detach. A VPC can have only one internet gateway.",
    },
  ],
  columns: [
    { label: "Attachment", path: "attributes.attachmentState" },
    { label: "VPC", path: "config.vpcId", mono: true },
  ],
  async validate({ config, existing, ctx }) {
    const before = (existing?.config.vpcId as string | undefined) || undefined;
    const after = (config.vpcId as string | undefined) || undefined;
    if (before === after) return;

    if (before && after) {
      throw new EngineError("Resource.AlreadyAssociated", `resource ${existing!.id} is already attached to network ${before}`);
    }

    if (before && !after) {
      // Detaching would strand instances that rely on the gateway for their public IPs.
      const exposed = [
        ...(await ctx.list("compute", "instance")).filter((i) => i.attributes.vpcId === before && i.attributes.publicIp),
        ...(await ctx.list("networking", "nat-gateway")).filter((n) => n.attributes.vpcId === before),
      ];
      if (exposed.length > 0) {
        throw new EngineError(
          "DependencyViolation",
          `Network ${before} has some mapped public address(es). Please unmap those public address(es) before detaching the gateway.`,
          400,
          { dependents: exposed.map((i) => i.id) },
        );
      }
    }

    if (after) {
      const taken = (await ctx.list("networking", "internet-gateway")).find(
        (g) => g.id !== existing?.id && g.config.vpcId === after,
      );
      if (taken) {
        throw new EngineError("Resource.AlreadyAssociated", `resource ${after} is already attached to network gateway ${taken.id}`);
      }
    }
  },
  async derive({ config }) {
    return { attachmentState: config.vpcId ? "attached" : "detached" };
  },
};

export const routeTable: ResourceTypeDef = {
  service: "networking",
  type: "route-table",
  label: "Route table",
  pluralLabel: "Route tables",
  description:
    "Decides where traffic leaving a subnet goes. Every table has an implicit local route for traffic inside the VPC.",
  idPrefix: "rtb",
  notFoundCode: "InvalidRouteTableID.NotFound",
  apiNoun: "routeTable",
  iam: {
    create: "ec2:CreateRouteTable",
    read: "ec2:DescribeRouteTables",
    update: (changed) => [
      ...(changed.includes("routes") ? ["ec2:CreateRoute"] : []),
      ...(changed.includes("subnetIds") ? ["ec2:AssociateRouteTable"] : []),
      ...(changed.includes("name") ? ["ec2:CreateTags"] : []),
    ],
    delete: "ec2:DeleteRouteTable",
    arn: ec2Arn("route-table"),
  },
  canDelete: (rt) =>
    systemOf(rt).main || ((rt.config.subnetIds as string[]) ?? []).length > 0
      ? new EngineError("DependencyViolation", `The routeTable '${rt.id}' has dependencies and cannot be deleted.`)
      : undefined,
  fields: [
    { key: "name", label: "Name tag", type: "string", maxLength: 255, placeholder: "public-rt" },
    {
      key: "vpcId",
      label: "VPC",
      type: "ref",
      required: true,
      immutable: true,
      ref: { service: "networking", type: "vpc" },
    },
    {
      key: "routes",
      label: "Routes",
      type: "list",
      maxItems: 50,
      description:
        "Each route needs one target. 0.0.0.0/0 → internet gateway makes subnets public; 0.0.0.0/0 → NAT gateway lets private subnets reach out.",
      item: [
        {
          key: "destination",
          label: "Destination",
          type: "cidr",
          required: true,
          prefix: { min: 0, max: 32 },
          placeholder: "0.0.0.0/0",
        },
        {
          key: "gatewayId",
          label: "Internet gateway",
          type: "ref",
          // Not tracked as a dependency: a detached or deleted gateway leaves a "blackhole" route, as in AWS.
          ref: { service: "networking", type: "internet-gateway", weak: true },
        },
        {
          key: "natGatewayId",
          label: "or NAT gateway",
          type: "ref",
          ref: { service: "networking", type: "nat-gateway", weak: true },
        },
      ],
    },
    {
      key: "subnetIds",
      label: "Associated subnets",
      type: "ref",
      // Deleting a subnet quietly removes its association, as in the real API.
      ref: { service: "networking", type: "subnet", multiple: true, weak: true },
      description:
        "Subnets that use this table. Subnets not associated with any table use the VPC's main route table.",
    },
  ],
  columns: [
    { label: "VPC", path: "config.vpcId", mono: true },
    { label: "Main", path: "attributes.system.main", boolean: true },
    { label: "Routes", path: "attributes.routeCount" },
    { label: "Subnets", path: "attributes.associationCount" },
  ],
  async validate({ config, existing, ctx }) {
    const vpcId = config.vpcId as string;
    const vpc = await ctx.get(vpcId);
    const vpcBlock = vpc ? parseCidr(vpc.config.cidrBlock as string) : null;

    const routes = (config.routes as Route[]) ?? [];
    const seen = new Set<string>();
    for (const route of routes) {
      if (seen.has(route.destination)) {
        throw new EngineError("RouteAlreadyExists", `The route identified by ${route.destination} already exists.`);
      }
      seen.add(route.destination);

      const dest = parseCidr(route.destination);
      if (dest && vpcBlock && cidrContains(vpcBlock, dest)) {
        throw new EngineError(
          "InvalidParameterValue",
          `The destination CIDR block ${route.destination} is equal to or more specific than one of this VPC's CIDR blocks. This route can target only an interface or an instance.`,
        );
      }

      if (route.gatewayId && route.natGatewayId) {
        throw new EngineError("InvalidParameterCombination", "Only one of gatewayId and natGatewayId can be specified for a route.");
      }
      if (!route.gatewayId && !route.natGatewayId) {
        throw new EngineError(
          "MissingParameter",
          "The request must contain exactly one of gatewayId, natGatewayId, networkInterfaceId, vpcPeeringConnectionId or instanceId",
          400,
          [{ field: "routes", message: `Choose a target for ${route.destination}: an internet gateway or a NAT gateway.` }],
        );
      }
      if (route.natGatewayId) {
        // Existing routes may point at a deleted NAT gateway (a blackhole); only new targets are checked.
        const known = ((existing?.config.routes as Route[] | undefined) ?? []).some(
          (r) => r.destination === route.destination && r.natGatewayId === route.natGatewayId,
        );
        if (known) continue;
        const nat = await ctx.get(route.natGatewayId);
        if (!nat || nat.type !== "nat-gateway") {
          throw new EngineError("NatGatewayNotFound", `The Nat Gateway ${route.natGatewayId} was not found`);
        }
        if (nat.attributes.vpcId !== vpcId) {
          throw new EngineError(
            "InvalidParameterValue",
            `route table ${existing?.id ?? "in " + vpcId} and NAT gateway ${nat.id} belong to different networks`,
          );
        }
        continue;
      }
      const gateway = await ctx.get(route.gatewayId!);
      if (!gateway || gateway.type !== "internet-gateway") {
        throw new EngineError("InvalidGatewayID.NotFound", `The gateway ID '${route.gatewayId}' does not exist`);
      }
      if (gateway.config.vpcId !== vpcId) {
        throw new EngineError(
          "InvalidParameterValue",
          `route table ${existing?.id ?? "in " + vpcId} and network gateway ${gateway.id} belong to different networks`,
        );
      }
    }

    const tables = await ctx.list("networking", "route-table");
    for (const subnetId of (config.subnetIds as string[]) ?? []) {
      const subnet = await ctx.get(subnetId);
      if (subnet && subnet.config.vpcId !== vpcId) {
        throw new EngineError(
          "InvalidParameterValue",
          `Route table ${existing?.id ?? "in " + vpcId} and subnet ${subnetId} belong to different networks`,
        );
      }
      const other = tables.find(
        (t) => t.id !== existing?.id && ((t.config.subnetIds as string[]) ?? []).includes(subnetId),
      );
      if (other) {
        throw new EngineError(
          "Resource.AlreadyAssociated",
          `the specified association for route table ${other.id} conflicts with an existing association`,
        );
      }
    }
  },
  async derive({ config, ctx }) {
    const vpc = await ctx.get(config.vpcId as string);
    const routes = (config.routes as unknown[]) ?? [];
    return {
      localRoute: vpc ? `${vpc.config.cidrBlock} → local` : null,
      routeCount: routes.length + 1,
      associationCount: ((config.subnetIds as string[]) ?? []).length,
    };
  },
};

export const natGateway: ResourceTypeDef = {
  service: "networking",
  type: "nat-gateway",
  label: "NAT gateway",
  pluralLabel: "NAT gateways",
  description:
    "Lets servers in private subnets start connections to the internet (for updates and APIs) while nobody on the internet can connect to them. It lives in a public subnet and uses an Elastic IP.",
  idPrefix: "nat",
  notFoundCode: "NatGatewayNotFound",
  notFoundMessage: (id) => `The Nat Gateway ${id} was not found`,
  malformedCode: "NatGatewayMalformed",
  apiNoun: "natGateway",
  iam: { create: "ec2:CreateNatGateway", read: "ec2:DescribeNatGateways", update: "ec2:CreateTags", delete: "ec2:DeleteNatGateway", arn: ec2Arn("natgateway") },
  fields: [
    { key: "name", label: "Name tag", type: "string", maxLength: 255, placeholder: "main-nat" },
    {
      key: "subnetId",
      label: "Subnet",
      type: "ref",
      required: true,
      immutable: true,
      ref: { service: "networking", type: "subnet" },
      description: "Put it in a public subnet: one whose route table sends 0.0.0.0/0 to an internet gateway.",
    },
    {
      key: "allocationId",
      label: "Elastic IP",
      type: "ref",
      required: true,
      immutable: true,
      ref: { service: "compute", type: "elastic-ip" },
      description: "An unassociated Elastic IP. Private servers' traffic leaves the VPC from this address.",
    },
  ],
  columns: [
    { label: "Subnet", path: "config.subnetId", mono: true },
    { label: "Public IP", path: "attributes.publicIp", mono: true },
    { label: "Private IP", path: "attributes.privateIp", mono: true },
  ],
  lifecycle: { create: { state: "pending", settlesTo: "available", afterMs: 5000 } },
  async validate({ config, existing, ctx }) {
    if (existing) return;
    const subnet = await ctx.get(config.subnetId as string);
    const eip = await ctx.get(config.allocationId as string);
    if (!subnet || !eip) return;
    const vpcId = subnet.config.vpcId as string;
    if (!(await ctx.list("networking", "internet-gateway")).some((g) => g.config.vpcId === vpcId)) {
      throw new EngineError("Gateway.NotAttached", `Network ${vpcId} has no Internet gateway attached`);
    }
    if (eip.config.instanceId || eip.attributes.natGatewayId) {
      throw new EngineError("Resource.AlreadyAssociated", `Elastic IP address [${eip.id}] is already associated`);
    }
  },
  async derive({ config, existing, ctx }) {
    if (existing) return existing.attributes;
    const subnet = await ctx.get(config.subnetId as string);
    const eip = await ctx.get(config.allocationId as string);
    return {
      vpcId: subnet?.config.vpcId ?? null,
      availabilityZone: subnet?.config.availabilityZone ?? null,
      privateIp: subnet ? await nextPrivateIp(ctx.list, subnet) : null,
      publicIp: eip?.attributes.publicIp ?? null,
      networkInterfaceId: generateId("eni"),
    };
  },
  async afterCreate({ resource, system }) {
    await system.setAttributes(resource.config.allocationId as string, {
      natGatewayId: resource.id,
      associationId: generateId("eipassoc"),
      privateIp: resource.attributes.privateIp,
    });
  },
  async afterDelete({ resource, system }) {
    // The Elastic IP is freed and can be released or reused.
    await system.setAttributes(resource.config.allocationId as string, { natGatewayId: null, associationId: null, privateIp: null });
  },
};
