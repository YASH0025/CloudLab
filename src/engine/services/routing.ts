import { cidrContains, parseCidr } from "../cidr";
import { EngineError } from "../errors";
import type { ResourceTypeDef } from "../types";

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
      throw new EngineError(
        "Resource.AlreadyAssociated",
        `${existing!.id} is already attached to ${before}. Detach it first, then attach it to ${after}.`,
        409,
      );
    }

    if (before && !after) {
      // Detaching would strand instances that rely on the gateway for their public IPs.
      const exposed = (await ctx.list("compute", "instance")).filter(
        (i) => i.attributes.vpcId === before && i.attributes.publicIp,
      );
      if (exposed.length > 0) {
        throw new EngineError(
          "DependencyViolation",
          `Network ${before} has mapped public addresses (${exposed.map((i) => i.id).join(", ")}). Terminate those instances or release their public IPs before detaching.`,
          409,
        );
      }
    }

    if (after) {
      const taken = (await ctx.list("networking", "internet-gateway")).find(
        (g) => g.id !== existing?.id && g.config.vpcId === after,
      );
      if (taken) {
        throw new EngineError(
          "Resource.AlreadyAssociated",
          `${after} already has internet gateway ${taken.id} attached. A VPC can have only one.`,
          409,
        );
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
      description: "Add 0.0.0.0/0 → internet gateway to make associated subnets public.",
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
          label: "Target (internet gateway)",
          type: "ref",
          required: true,
          ref: { service: "networking", type: "internet-gateway" },
        },
      ],
    },
    {
      key: "subnetIds",
      label: "Associated subnets",
      type: "ref",
      ref: { service: "networking", type: "subnet", multiple: true },
      description:
        "Subnets that use this table. Subnets not associated with any table use the VPC's main table, which only routes locally.",
    },
  ],
  columns: [
    { label: "VPC", path: "config.vpcId", mono: true },
    { label: "Routes", path: "attributes.routeCount" },
    { label: "Subnets", path: "attributes.associationCount" },
  ],
  async validate({ config, existing, ctx }) {
    const vpcId = config.vpcId as string;
    const vpc = await ctx.get(vpcId);
    const vpcBlock = vpc ? parseCidr(vpc.config.cidrBlock as string) : null;

    const routes = (config.routes as { destination: string; gatewayId: string }[]) ?? [];
    const seen = new Set<string>();
    for (const route of routes) {
      if (seen.has(route.destination)) {
        throw new EngineError(
          "RouteAlreadyExists",
          `The route table already has a route for ${route.destination}.`,
          409,
        );
      }
      seen.add(route.destination);

      const dest = parseCidr(route.destination);
      if (dest && vpcBlock && cidrContains(vpcBlock, dest)) {
        throw new EngineError(
          "InvalidParameterValue",
          `${route.destination} is inside the VPC range ${vpc!.config.cidrBlock}, which the local route already covers.`,
        );
      }

      const gateway = await ctx.get(route.gatewayId);
      if (!gateway || gateway.type !== "internet-gateway") {
        throw new EngineError(
          "InvalidInternetGatewayID.NotFound",
          `The internet gateway '${route.gatewayId}' does not exist.`,
          404,
        );
      }
      if (gateway.config.vpcId !== vpcId) {
        throw new EngineError(
          "InvalidParameterValue",
          `Route table and gateway ${gateway.id} belong to different networks. Attach ${gateway.id} to ${vpcId} first.`,
        );
      }
    }

    const tables = await ctx.list("networking", "route-table");
    for (const subnetId of (config.subnetIds as string[]) ?? []) {
      const subnet = await ctx.get(subnetId);
      if (subnet && subnet.config.vpcId !== vpcId) {
        throw new EngineError(
          "InvalidParameterValue",
          `Subnet ${subnetId} is in ${subnet.config.vpcId}, but this route table is in ${vpcId}.`,
        );
      }
      const other = tables.find(
        (t) => t.id !== existing?.id && ((t.config.subnetIds as string[]) ?? []).includes(subnetId),
      );
      if (other) {
        throw new EngineError(
          "Resource.AlreadyAssociated",
          `Subnet ${subnetId} is already associated with ${other.id}. A subnet can use only one route table.`,
          409,
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
