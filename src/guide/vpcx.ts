import { cidrOverlaps, parseCidr } from "@/engine/cidr";
import type { Engine } from "@/engine/engine";
import { systemOf, type Resource } from "@/engine/types";

/** What the networking tutorial looks at, around the learner's own VPC and web server. */
export interface VpcxState {
  /** A second VPC whose range doesn't overlap the first. */
  shared?: Resource;
  peering?: Resource;
  /** Whether each side has a route table sending the other's range to the peering connection. */
  routeThere: boolean;
  routeBack: boolean;
  /** A custom network ACL on the web server's subnet. */
  acl?: Resource;
  /** An S3 gateway endpoint in the VPC, attached to at least one route table. */
  endpoint?: Resource;
}

const hasPcxRoute = (tables: Resource[], vpcId: string | undefined, pcx: Resource | undefined) =>
  !!pcx && tables.some((t) => t.config.vpcId === vpcId && ((t.config.routes as { vpcPeeringConnectionId?: string }[] | undefined) ?? []).some((r) => r.vpcPeeringConnectionId === pcx.id));

export async function loadVpcx(engine: Engine, accountId: string, region: string, vpc: Resource | undefined, instance: Resource | undefined): Promise<VpcxState> {
  const list = (type: string) => engine.list(accountId, { service: "networking", type, region });
  const [vpcs, peerings, tables, acls, endpoints] = await Promise.all([list("vpc"), list("peering-connection"), list("route-table"), list("network-acl"), list("vpc-endpoint")]);
  const mine = vpc ? parseCidr(String(vpc.config.cidrBlock)) : null;
  const shared = vpc
    ? vpcs
        .filter((v) => v.id !== vpc.id && !systemOf(v).isDefault)
        .filter((v) => {
          const c = parseCidr(String(v.config.cidrBlock));
          return !!c && !!mine && !cidrOverlaps(c, mine);
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    : undefined;
  const peering = shared
    ? peerings
        .filter((p) => [p.config.vpcId, p.config.peerVpcId].includes(vpc!.id) && [p.config.vpcId, p.config.peerVpcId].includes(shared.id) && !["rejected", "deleted", "failed"].includes(p.state ?? ""))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    : undefined;
  const subnetId = instance?.config.subnetId as string | undefined;
  return {
    shared,
    peering,
    routeThere: hasPcxRoute(tables, vpc?.id, peering),
    routeBack: hasPcxRoute(tables, shared?.id, peering),
    acl: subnetId ? acls.find((a) => !systemOf(a).isDefault && ((a.config.subnetIds as string[] | undefined) ?? []).includes(subnetId)) : undefined,
    endpoint: vpc ? endpoints.find((e) => e.config.vpcId === vpc.id && e.config.service === "s3" && ((e.config.routeTableIds as string[] | undefined) ?? []).length > 0) : undefined,
  };
}
