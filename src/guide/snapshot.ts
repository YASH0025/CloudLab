import { cidrOverlaps, intToIp, parseCidr } from "@/engine/cidr";
import type { Engine } from "@/engine/engine";
import { systemOf, type Resource } from "@/engine/types";

/** Everything the learner has in a region, loaded once for the guide's checks. */
export interface Snapshot {
  region: string;
  accountId: string;
  vpcs: Resource[];
  subnets: Resource[];
  gateways: Resource[];
  routeTables: Resource[];
  groups: Resource[];
  /** Active instances (terminated ones are left out). */
  instances: Resource[];
  /** Buckets in every region (bucket names are global). */
  buckets: Resource[];
  /** Elastic IPs. */
  addresses: Resource[];
}

export async function takeSnapshot(engine: Engine, accountId: string, region: string): Promise<Snapshot> {
  const list = (service: string, type: string, allRegions = false) =>
    engine.list(accountId, { service, type, region: allRegions ? undefined : region });
  const [vpcs, subnets, gateways, routeTables, groups, instances, buckets, addresses] = await Promise.all([
    list("networking", "vpc"),
    list("networking", "subnet"),
    list("networking", "internet-gateway"),
    list("networking", "route-table"),
    list("networking", "security-group"),
    list("compute", "instance"),
    list("storage", "bucket", true),
    list("compute", "elastic-ip"),
  ]);
  return {
    region,
    accountId,
    vpcs,
    subnets,
    gateways,
    routeTables,
    groups,
    instances: instances.filter((i) => i.state !== "terminated"),
    buckets,
    addresses,
  };
}

export const label = (r: Resource) => (r.name ? `${r.name} (${r.id})` : r.id);

export interface SgRule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidr: string;
}

/** First /24 inside the VPC that doesn't overlap an existing subnet, e.g. 10.0.1.0/24. */
export function freeSubnetCidr(vpc: Resource, subnets: Resource[]): string | undefined {
  const block = parseCidr(vpc.config.cidrBlock as string);
  if (!block) return undefined;
  const prefix = Math.max(24, block.prefix);
  const size = 2 ** (32 - prefix);
  const total = 2 ** (32 - block.prefix);
  const taken = subnets.map((s) => parseCidr(s.config.cidrBlock as string)).filter((c) => c !== null);
  for (let offset = size; offset < total; offset += size) {
    const candidate = { network: block.network + offset, prefix };
    if (!taken.some((t) => cidrOverlaps(t, candidate))) return `${intToIp(candidate.network)}/${prefix}`;
  }
  return undefined;
}

/** Resources the learner made, as opposed to the platform (default VPC, main route tables, default groups). */
export const isOwn = (r: Resource) => {
  const sys = systemOf(r);
  return !sys.isDefault && !sys.main && !sys.defaultForAz;
};

/**
 * The VPC the learner is working in: the one with their newest instance, else their
 * newest VPC with subnets, else their newest VPC. The default VPC only counts if
 * `includeDefault` is set and they've launched something into it.
 */
export function focusVpc(s: Snapshot, includeDefault = true): Resource | undefined {
  const candidates = includeDefault ? s.vpcs : s.vpcs.filter(isOwn);
  const newest = s.instances.find((i) => candidates.some((v) => v.id === i.attributes.vpcId));
  const byInstance = newest && candidates.find((v) => v.id === newest.attributes.vpcId);
  if (byInstance) return byInstance;
  const own = candidates.filter(isOwn);
  return own.find((v) => s.subnets.some((sub) => sub.config.vpcId === v.id)) ?? own[0];
}

/** The route table a subnet actually uses: its explicit association, else its VPC's main table. */
export function effectiveRouteTable(s: Snapshot, subnet: Resource): Resource | undefined {
  return (
    s.routeTables.find((t) => ((t.config.subnetIds as string[]) ?? []).includes(subnet.id)) ??
    s.routeTables.find((t) => systemOf(t).main && t.config.vpcId === subnet.config.vpcId)
  );
}

/** A bucket name that is stable per account and very likely unique. */
export function bucketName(accountId: string) {
  let h = 0;
  for (const ch of accountId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `lab-assets-${h.toString(36).slice(0, 6)}`;
}
