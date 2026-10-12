import type { Engine } from "@/engine/engine";
import { isRootVolume } from "@/engine/services/ebs";
import { listenersOf } from "@/engine/services/loadbalancing";
import { aclFor } from "@/engine/services/vpc-extras";
import { systemOf, type Resource } from "@/engine/types";
import { defaultRoute, effectiveRouteTable, isPublicSubnet, routesToNat, takeSnapshot } from "./snapshot";

/**
 * The network diagram: a region's VPCs, laid out the way AWS diagrams draw
 * them (VPC → Availability Zone → subnet → what runs inside), plus the links
 * between them (internet gateway, peering, endpoints) and the regional
 * services outside any VPC.
 */

export interface DiagramRef {
  id: string;
  name: string;
  service: string;
  type: string;
}

export interface DiagramNode extends DiagramRef {
  state: string | null;
  /** One short line: an IP, an engine, a role. */
  detail?: string;
  /** Instances: their security groups; databases: primary/standby. */
  tags?: string[];
}

export interface DiagramSubnet extends DiagramRef {
  cidr: string;
  /** public: 0.0.0.0/0 → internet gateway; private: → NAT gateway; isolated: no way out. */
  kind: "public" | "private" | "isolated";
  route: string;
  routeTable?: DiagramRef;
  acl?: DiagramRef & { isDefault: boolean };
  nodes: DiagramNode[];
}

export interface DiagramVpc extends DiagramRef {
  cidr: string;
  isDefault: boolean;
  internetGateway?: DiagramRef;
  endpoints: (DiagramRef & { service: string; serviceName: string })[];
  peerings: (DiagramRef & { otherVpc: string; otherName: string; state: string | null })[];
  zones: { name: string; subnets: DiagramSubnet[] }[];
  loadBalancers: (DiagramNode & { zones: string[]; targets: string[] })[];
}

export interface Diagram {
  region: string;
  vpcs: DiagramVpc[];
  /** Services that live outside any VPC. */
  regional: DiagramNode[];
}

const ref = (r: Resource): DiagramRef => ({ id: r.id, name: r.name, service: r.service, type: r.type });
const node = (r: Resource, detail?: string, tags?: string[]): DiagramNode => ({ ...ref(r), state: r.state, ...(detail ? { detail } : {}), ...(tags?.length ? { tags } : {}) });

export async function buildDiagram(engine: Engine, accountId: string, region: string): Promise<Diagram> {
  const list = (service: string, type: string) => engine.list(accountId, { service, type, region });
  const [s, acls, peerings, endpoints, lbs, dbs, volumes, functions, apis, topics, queues, tables] = await Promise.all([
    takeSnapshot(engine, accountId, region),
    list("networking", "network-acl"),
    list("networking", "peering-connection"),
    list("networking", "vpc-endpoint"),
    list("loadbalancing", "load-balancer"),
    list("rds", "db-instance"),
    list("compute", "volume"),
    list("lambda", "function"),
    list("apigateway", "api"),
    list("sns", "topic"),
    list("sqs", "queue"),
    list("dynamodb", "table"),
  ]);
  const tgs = await list("loadbalancing", "target-group");
  const groupName = (id: string) => {
    const g = s.groups.find((x) => x.id === id);
    return g ? g.name || g.id : id;
  };
  const vpcName = (id: string) => {
    const v = s.vpcs.find((x) => x.id === id);
    return v ? v.name || v.id : id;
  };

  const vpcs: DiagramVpc[] = s.vpcs
    .slice()
    .sort((a, b) => Number(systemOf(a).isDefault ?? false) - Number(systemOf(b).isDefault ?? false) || a.createdAt.localeCompare(b.createdAt))
    .map((vpc) => {
      const subnets = s.subnets.filter((x) => x.config.vpcId === vpc.id);
      const zoneNames = [...new Set(subnets.map((x) => String(x.config.availabilityZone)))].sort();
      const zones = zoneNames.map((name) => ({
        name,
        subnets: subnets
          .filter((x) => x.config.availabilityZone === name)
          .sort((a, b) => String(a.config.cidrBlock).localeCompare(String(b.config.cidrBlock), undefined, { numeric: true }))
          .map((subnet): DiagramSubnet => {
            const table = effectiveRouteTable(s, subnet);
            const route = defaultRoute(s, subnet);
            const nat = routesToNat(s, subnet);
            const kind = isPublicSubnet(s, subnet) ? "public" : nat ? "private" : "isolated";
            const acl = aclFor(subnet, acls);
            const nodes: DiagramNode[] = [];
            for (const n of s.natGateways.filter((x) => x.config.subnetId === subnet.id && x.state !== "deleted")) {
              nodes.push(node(n, n.attributes.publicIp ? `NAT · ${String(n.attributes.publicIp)}` : "NAT gateway"));
            }
            for (const i of s.instances.filter((x) => x.config.subnetId === subnet.id)) {
              const disks = volumes.filter((v) => v.config.instanceId === i.id && !isRootVolume(v)).length;
              const ip = i.attributes.publicIp ? `${String(i.attributes.privateIp)} · ${String(i.attributes.publicIp)}` : String(i.attributes.privateIp);
              nodes.push(node(i, `${ip}${disks ? ` · +${disks} disk${disks > 1 ? "s" : ""}` : ""}`, ((i.config.securityGroupIds as string[]) ?? []).map(groupName)));
            }
            for (const db of dbs) {
              if (db.attributes.subnetId === subnet.id) nodes.push(node(db, `${String(db.config.engine)} · ${String(db.attributes.privateIp ?? "")}`, ["primary"]));
              if (db.attributes.standbySubnetId === subnet.id) nodes.push(node(db, `${String(db.config.engine)} standby · ${String(db.attributes.standbyPrivateIp ?? "")}`, ["standby"]));
            }
            return {
              ...ref(subnet),
              cidr: String(subnet.config.cidrBlock),
              kind,
              route: route ? `0.0.0.0/0 → ${route.gatewayId || route.natGatewayId}` : "local only",
              ...(table ? { routeTable: ref(table) } : {}),
              ...(acl ? { acl: { ...ref(acl), isDefault: !!systemOf(acl).isDefault } } : {}),
              nodes,
            };
          }),
      }));
      const igw = s.gateways.find((g) => g.config.vpcId === vpc.id);
      const subnetIds = new Set(subnets.map((x) => x.id));
      return {
        ...ref(vpc),
        cidr: String(vpc.config.cidrBlock),
        isDefault: !!systemOf(vpc).isDefault,
        ...(igw ? { internetGateway: ref(igw) } : {}),
        endpoints: endpoints
          .filter((e) => e.config.vpcId === vpc.id)
          .map((e) => ({ ...ref(e), service: String(e.config.service), serviceName: String(e.attributes.serviceName) })),
        peerings: peerings
          .filter((p) => (p.config.vpcId === vpc.id || p.config.peerVpcId === vpc.id) && !["rejected", "deleted"].includes(p.state ?? ""))
          .map((p) => {
            const other = String(p.config.vpcId === vpc.id ? p.config.peerVpcId : p.config.vpcId);
            return { ...ref(p), otherVpc: other, otherName: vpcName(other), state: p.state };
          }),
        zones,
        loadBalancers: lbs
          .filter((lb) => ((lb.config.subnetIds as string[]) ?? []).some((id) => subnetIds.has(id)))
          .map((lb) => {
            const targets = listenersOf(lb).flatMap((l) => ((tgs.find((t) => t.id === l.targetGroupId)?.config.targets as string[] | undefined) ?? []));
            return {
              ...node(lb, `${String(lb.config.scheme)} · ${String(lb.attributes.dnsName)}`),
              zones: (lb.attributes.availabilityZones as string[] | undefined) ?? [],
              targets: [...new Set(targets)],
            };
          }),
      };
    });

  const regional: DiagramNode[] = [
    ...s.buckets.filter((b) => b.region === region).map((b) => node(b, b.config.websiteEnabled ? "S3 · website" : "S3 bucket")),
    ...functions.map((f) => node(f, `Lambda · ${String(f.config.runtime)}`)),
    ...apis.map((a) => node(a, "API Gateway · HTTP API")),
    ...tables.map((t) => node(t, `DynamoDB · ${String(t.config.partitionKey)}${t.config.sortKey ? ` + ${String(t.config.sortKey)}` : ""}`)),
    ...topics.map((t) => node(t, "SNS topic")),
    ...queues.map((q) => node(q, q.config.deadLetterQueue ? `SQS queue · dead-letter → ${String(q.config.deadLetterQueue).split("/").pop()}` : "SQS queue")),
  ];
  return { region, vpcs, regional };
}
