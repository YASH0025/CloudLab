import type { Engine } from "@/engine/engine";
import { systemOf, type Resource } from "@/engine/types";

/**
 * Shapes simulated resources like the real CLI's JSON output (PascalCase
 * keys, nested Tags, State objects), so what learners see matches what
 * they will meet at work.
 */

export interface PresentContext {
  engine: Engine;
  accountId: string;
}

import { accountNumber } from "@/engine/ids";

/** The 12-digit account number shown as OwnerId. */
export const ownerId = accountNumber;

export function tags(r: Resource) {
  return r.name ? [{ Key: "Name", Value: r.name }] : undefined;
}

/** Instance state codes used by the real API. */
export const STATE_CODES: Record<string, number> = {
  pending: 0,
  running: 16,
  "shutting-down": 32,
  terminated: 48,
  stopping: 64,
  stopped: 80,
  rebooting: 16,
};

export const instanceState = (state: string | null) => ({
  Code: STATE_CODES[state ?? ""] ?? 0,
  Name: state === "rebooting" ? "running" : state,
});

export const associationId = (subnetId: string) => `rtbassoc-${subnetId.replace(/^subnet-/, "")}`;
export const reservationId = (instanceId: string) => `r-${instanceId.replace(/^i-/, "")}`;

export function vpc(r: Resource, ctx: PresentContext) {
  return {
    CidrBlock: r.config.cidrBlock,
    State: r.state,
    VpcId: r.id,
    OwnerId: ownerId(ctx.accountId),
    InstanceTenancy: "default",
    IsDefault: systemOf(r).isDefault === true,
    Tags: tags(r),
  };
}

export function subnet(r: Resource, ctx: PresentContext) {
  return {
    AvailabilityZone: r.config.availabilityZone,
    AvailableIpAddressCount: r.attributes.availableIpCount,
    CidrBlock: r.config.cidrBlock,
    DefaultForAz: systemOf(r).defaultForAz === true,
    MapPublicIpOnLaunch: Boolean(r.config.mapPublicIpOnLaunch),
    State: r.state,
    SubnetId: r.id,
    VpcId: r.config.vpcId,
    OwnerId: ownerId(ctx.accountId),
    Tags: tags(r),
  };
}

export function internetGateway(r: Resource, ctx: PresentContext) {
  return {
    Attachments: r.config.vpcId ? [{ State: "available", VpcId: r.config.vpcId }] : [],
    InternetGatewayId: r.id,
    OwnerId: ownerId(ctx.accountId),
    Tags: tags(r),
  };
}

export async function routeTable(r: Resource, ctx: PresentContext) {
  const vpcRes = await ctx.engine.get(ctx.accountId, r.config.vpcId as string).catch(() => null);
  const routes = (r.config.routes as { destination: string; gatewayId?: string; natGatewayId?: string }[]) ?? [];
  const routeEntries = await Promise.all(
    routes.map(async (route) => {
      if (route.natGatewayId) {
        const nat = await ctx.engine.get(ctx.accountId, route.natGatewayId).catch(() => null);
        return {
          DestinationCidrBlock: route.destination,
          NatGatewayId: route.natGatewayId,
          Origin: "CreateRoute",
          State: nat ? "active" : "blackhole",
        };
      }
      const gw = route.gatewayId ? await ctx.engine.get(ctx.accountId, route.gatewayId).catch(() => null) : null;
      const attached = gw && gw.config.vpcId === r.config.vpcId;
      return {
        DestinationCidrBlock: route.destination,
        GatewayId: route.gatewayId,
        Origin: "CreateRoute",
        State: attached ? "active" : "blackhole",
      };
    }),
  );
  const main = systemOf(r).main
    ? [
        {
          Main: true,
          RouteTableAssociationId: `rtbassoc-${r.id.replace(/^rtb-/, "")}`,
          RouteTableId: r.id,
          AssociationState: { State: "associated" },
        },
      ]
    : [];
  return {
    Associations: [...main, ...((r.config.subnetIds as string[]) ?? []).map((subnetId) => ({
      Main: false,
      RouteTableAssociationId: associationId(subnetId),
      RouteTableId: r.id,
      SubnetId: subnetId,
      AssociationState: { State: "associated" },
    }))],
    RouteTableId: r.id,
    Routes: [
      ...(vpcRes
        ? [{ DestinationCidrBlock: vpcRes.config.cidrBlock, GatewayId: "local", Origin: "CreateRouteTable", State: "active" }]
        : []),
      ...routeEntries,
    ],
    VpcId: r.config.vpcId,
    OwnerId: ownerId(ctx.accountId),
    Tags: tags(r),
  };
}

interface Rule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidr?: string;
  sourceGroupId?: string;
  description?: string;
}

function permissions(rules: Rule[] | undefined, owner: string) {
  const desc = (rule: Rule) => (rule.description ? { Description: rule.description } : {});
  return (rules ?? []).map((rule) => ({
    IpProtocol: rule.protocol === "all" ? "-1" : rule.protocol,
    ...(rule.protocol === "all" ? {} : { FromPort: rule.fromPort ?? -1, ToPort: rule.toPort ?? -1 }),
    IpRanges: rule.cidr ? [{ CidrIp: rule.cidr, ...desc(rule) }] : [],
    UserIdGroupPairs: rule.sourceGroupId ? [{ GroupId: rule.sourceGroupId, UserId: owner, ...desc(rule) }] : [],
  }));
}

export function securityGroup(r: Resource, ctx: PresentContext) {
  return {
    Description: r.config.description,
    GroupName: r.config.name,
    IpPermissions: permissions(r.config.inboundRules as Rule[], ownerId(ctx.accountId)),
    OwnerId: ownerId(ctx.accountId),
    GroupId: r.id,
    IpPermissionsEgress: permissions(r.config.outboundRules as Rule[], ownerId(ctx.accountId)),
    VpcId: r.config.vpcId,
  };
}

export async function instance(r: Resource, ctx: PresentContext) {
  const groups = await Promise.all(
    ((r.config.securityGroupIds as string[]) ?? []).map(async (id) => {
      const g = await ctx.engine.get(ctx.accountId, id).catch(() => null);
      return { GroupId: id, GroupName: g?.config.name ?? null };
    }),
  );
  return {
    InstanceId: r.id,
    ImageId: r.config.imageId,
    InstanceType: r.config.instanceType,
    KeyName: r.config.keyName ?? undefined,
    LaunchTime: r.createdAt,
    Placement: { AvailabilityZone: r.attributes.availabilityZone, Tenancy: "default" },
    Platform: r.attributes.platform === "windows" ? "windows" : undefined,
    PrivateIpAddress: r.attributes.privateIp ?? undefined,
    PublicIpAddress: r.attributes.publicIp ?? undefined,
    State: instanceState(r.state),
    SubnetId: r.config.subnetId,
    VpcId: r.attributes.vpcId,
    SecurityGroups: groups,
    Tags: tags(r),
  };
}

export async function reservation(r: Resource, ctx: PresentContext) {
  return {
    ReservationId: reservationId(r.id),
    OwnerId: ownerId(ctx.accountId),
    Groups: [],
    Instances: [await instance(r, ctx)],
  };
}

export function keyPair(r: Resource, opts: { includePublicKey?: boolean } = {}) {
  return {
    KeyPairId: r.id,
    KeyFingerprint: r.attributes.fingerprint,
    KeyName: r.name,
    KeyType: r.config.keyType,
    Tags: [],
    ...(opts.includePublicKey ? { PublicKey: r.attributes.publicKey } : {}),
    CreateTime: r.createdAt,
  };
}

export function address(r: Resource) {
  const instanceId = (r.config.instanceId as string | undefined) || undefined;
  const natId = r.attributes.natGatewayId as string | undefined;
  return {
    AllocationId: r.id,
    ...(natId
      ? {
          AssociationId: r.attributes.associationId,
          NetworkInterfaceId: `eni-${natId.replace(/^nat-/, "")}`,
          NetworkInterfaceOwnerId: "amazon-elb",
          PrivateIpAddress: r.attributes.privateIp ?? undefined,
        }
      : {}),
    ...(instanceId
      ? {
          AssociationId: r.attributes.associationId,
          InstanceId: instanceId,
          NetworkInterfaceId: `eni-${instanceId.replace(/^i-/, "")}`,
          PrivateIpAddress: r.attributes.privateIp ?? undefined,
        }
      : {}),
    Domain: "vpc",
    NetworkBorderGroup: r.attributes.networkBorderGroup ?? r.region,
    PublicIp: r.attributes.publicIp,
    PublicIpv4Pool: "amazon",
    Tags: tags(r),
  };
}

export function natGateway(r: Resource) {
  // While it's being created the address is still "associating".
  const status = r.state === "available" ? "succeeded" : "associating";
  return {
    CreateTime: r.createdAt,
    NatGatewayAddresses: [
      {
        AllocationId: r.config.allocationId,
        NetworkInterfaceId: r.attributes.networkInterfaceId,
        PrivateIp: r.attributes.privateIp,
        PublicIp: r.attributes.publicIp,
        IsPrimary: true,
        Status: status,
      },
    ],
    NatGatewayId: r.id,
    State: r.state,
    SubnetId: r.config.subnetId,
    VpcId: r.attributes.vpcId,
    Tags: tags(r),
    ConnectivityType: "public",
  };
}
