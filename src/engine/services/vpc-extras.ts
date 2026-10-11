import { cidrContains, cidrOverlaps, parseCidr } from "../cidr";
import { EngineError } from "../errors";
import { ec2Arn } from "../iam/arns";
import { systemOf, type FieldDef, type Resource, type ResourceTypeDef } from "../types";

/**
 * More of the VPC: network ACLs (a stateless firewall for whole subnets),
 * VPC peering (a private link between two VPCs) and gateway VPC endpoints
 * (reaching S3 or DynamoDB without going through the internet).
 */

// ---------- network ACLs ----------

export interface AclRule {
  ruleNumber: number;
  protocol: "tcp" | "udp" | "icmp" | "all";
  fromPort?: number;
  toPort?: number;
  cidr: string;
  action: "allow" | "deny";
}

/** The ports clients use for replies. Linux picks 32768–60999, Windows 49152–65535; NACL advice is 1024–65535. */
export const EPHEMERAL_PORT = 49152;

export const DEFAULT_ACL_RULES: AclRule[] = [{ ruleNumber: 100, protocol: "all", cidr: "0.0.0.0/0", action: "allow" }];

const aclRuleItem: FieldDef[] = [
  { key: "ruleNumber", label: "Rule #", type: "number", required: true, min: 1, max: 32766, placeholder: "100" },
  {
    key: "protocol",
    label: "Protocol",
    type: "enum",
    required: true,
    default: "tcp",
    options: [
      { value: "tcp", label: "TCP" },
      { value: "udp", label: "UDP" },
      { value: "icmp", label: "ICMP" },
      { value: "all", label: "All traffic" },
    ],
  },
  { key: "fromPort", label: "From port", type: "number", min: 0, max: 65535, placeholder: "80" },
  { key: "toPort", label: "To port", type: "number", min: 0, max: 65535, placeholder: "80" },
  { key: "cidr", label: "Address range", type: "cidr", required: true, prefix: { min: 0, max: 32 }, placeholder: "0.0.0.0/0" },
  {
    key: "action",
    label: "Allow / Deny",
    type: "enum",
    required: true,
    default: "allow",
    options: [
      { value: "allow", label: "Allow" },
      { value: "deny", label: "Deny" },
    ],
  },
];

export const aclRules = (acl: Resource | undefined, egress: boolean) =>
  (((acl?.config[egress ? "outboundRules" : "inboundRules"] as AclRule[] | undefined) ?? []).slice().sort((a, b) => a.ruleNumber - b.ruleNumber));

/**
 * What a network ACL does with some traffic: rules are checked in number order
 * and the first that matches decides; if none matches, the final "*" rule denies.
 */
export function aclDecision(acl: Resource | undefined, egress: boolean, protocol: string, port: number | undefined, cidr: string): { allowed: boolean; rule?: AclRule } {
  if (!acl) return { allowed: true };
  const target = parseCidr(cidr);
  for (const r of aclRules(acl, egress)) {
    if (r.protocol !== "all" && r.protocol !== protocol) continue;
    if (r.protocol !== "all" && protocol !== "icmp" && (port === undefined || port < (r.fromPort ?? -1) || port > (r.toPort ?? -1))) continue;
    const range = parseCidr(r.cidr);
    if (!range || !target || !cidrContains(range, target)) continue;
    return { allowed: r.action === "allow", rule: r };
  }
  return { allowed: false };
}

/** A subnet uses the custom network ACL it's associated with, otherwise its VPC's default one. */
export function aclFor(subnet: Resource | null | undefined, acls: Resource[]): Resource | undefined {
  if (!subnet) return undefined;
  return (
    acls.find((a) => ((a.config.subnetIds as string[] | undefined) ?? []).includes(subnet.id)) ??
    acls.find((a) => systemOf(a).isDefault && a.config.vpcId === subnet.config.vpcId)
  );
}

function checkAclRules(rules: AclRule[], direction: string) {
  const seen = new Set<number>();
  for (const r of rules) {
    if (seen.has(r.ruleNumber)) throw new EngineError("NetworkAclEntryAlreadyExists", `The network acl entry identified by ${r.ruleNumber} already exists.`);
    seen.add(r.ruleNumber);
    if ((r.protocol === "tcp" || r.protocol === "udp") && (r.fromPort === undefined || r.toPort === undefined)) {
      throw new EngineError("MissingParameter", `The request must contain the parameter portRange (${direction} rule ${r.ruleNumber}).`);
    }
    if (r.fromPort !== undefined && r.toPort !== undefined && r.fromPort > r.toPort) {
      throw new EngineError("InvalidParameterValue", `Invalid port range ${r.fromPort}-${r.toPort} in ${direction} rule ${r.ruleNumber}: From must not be greater than To.`);
    }
  }
}

export const networkAcl: ResourceTypeDef = {
  service: "networking",
  type: "network-acl",
  label: "Network ACL",
  pluralLabel: "Network ACLs",
  description:
    "A firewall for whole subnets. Unlike security groups, rules can deny, they're checked in number order, and they're stateless: replies need their own rule (ports 1024–65535).",
  idPrefix: "acl",
  notFoundCode: "InvalidNetworkAclID.NotFound",
  notFoundMessage: (id) => `The networkAcl ID '${id}' does not exist`,
  apiNoun: "networkAcl",
  panelAttributes: ["inboundCount", "outboundCount"],
  iam: {
    create: "ec2:CreateNetworkAcl",
    read: "ec2:DescribeNetworkAcls",
    update: (changed) => [
      ...(changed.some((c) => c === "inboundRules" || c === "outboundRules") ? ["ec2:CreateNetworkAclEntry", "ec2:ReplaceNetworkAclEntry", "ec2:DeleteNetworkAclEntry"] : []),
      ...(changed.includes("subnetIds") ? ["ec2:ReplaceNetworkAclAssociation"] : []),
      ...(changed.includes("name") ? ["ec2:CreateTags"] : []),
    ],
    delete: "ec2:DeleteNetworkAcl",
    arn: ec2Arn("network-acl"),
  },
  canDelete: (acl) => {
    if (systemOf(acl).isDefault) return new EngineError("InvalidParameterValue", `cannot delete default network ACL ${acl.id}`);
    if (((acl.config.subnetIds as string[] | undefined) ?? []).length > 0) {
      return new EngineError("DependencyViolation", `The networkAcl '${acl.id}' has dependencies and cannot be deleted.`);
    }
    return undefined;
  },
  fields: [
    { key: "name", label: "Name tag", type: "string", maxLength: 255, placeholder: "public-subnets-acl" },
    { key: "vpcId", label: "VPC", type: "ref", required: true, immutable: true, ref: { service: "networking", type: "vpc" } },
    {
      key: "inboundRules",
      itemLabel: "rule",
      label: "Inbound rules",
      type: "list",
      maxItems: 20,
      item: aclRuleItem,
      description: "Checked from the lowest number up; the first match decides. Anything no rule matches is denied. A new ACL denies everything.",
    },
    {
      key: "outboundRules",
      itemLabel: "rule",
      label: "Outbound rules",
      type: "list",
      maxItems: 20,
      item: aclRuleItem,
      description: "Remember the replies: a web server needs outbound TCP 1024–65535 to answer visitors.",
    },
    {
      key: "subnetIds",
      label: "Associated subnets",
      type: "ref",
      ref: { service: "networking", type: "subnet", multiple: true, weak: true },
      description: "Subnets that use this ACL (a subnet has exactly one; adding it here moves it from its current ACL). The rest use the VPC's default ACL.",
    },
  ],
  columns: [
    { label: "VPC", path: "config.vpcId", mono: true },
    { label: "Default", path: "attributes.system.isDefault", boolean: true },
    { label: "Inbound rules", path: "attributes.inboundCount" },
    { label: "Outbound rules", path: "attributes.outboundCount" },
  ],
  async validate({ config, ctx }) {
    checkAclRules((config.inboundRules as AclRule[] | undefined) ?? [], "inbound");
    checkAclRules((config.outboundRules as AclRule[] | undefined) ?? [], "outbound");
    for (const id of (config.subnetIds as string[] | undefined) ?? []) {
      const subnet = await ctx.get(id);
      if (subnet && subnet.config.vpcId !== config.vpcId) {
        throw new EngineError("InvalidParameterValue", `Network ACL and subnet ${id} belong to different networks`);
      }
    }
  },
  async derive({ config }) {
    return {
      inboundCount: ((config.inboundRules as unknown[] | undefined) ?? []).length,
      outboundCount: ((config.outboundRules as unknown[] | undefined) ?? []).length,
    };
  },
  /** A subnet belongs to one ACL: associating it here takes it away from any other custom ACL. */
  async afterCreate({ resource, system }) {
    await takeSubnets(system, resource);
  },
  async afterUpdate({ resource, system }) {
    await takeSubnets(system, resource);
  },
};

async function takeSubnets(system: { list(service: string, type: string): Promise<Resource[]>; update(id: string, patch: Record<string, unknown>): Promise<Resource> }, acl: Resource) {
  const mine = new Set((acl.config.subnetIds as string[] | undefined) ?? []);
  if (mine.size === 0) return;
  for (const other of await system.list("networking", "network-acl")) {
    if (other.id === acl.id) continue;
    const theirs = (other.config.subnetIds as string[] | undefined) ?? [];
    if (theirs.some((s) => mine.has(s))) await system.update(other.id, { subnetIds: theirs.filter((s) => !mine.has(s)) });
  }
}

/** The default ACL every VPC gets: allow everything in and out (plus the final deny nobody reaches). */
export function defaultAclConfig(vpcId: string) {
  return { vpcId, inboundRules: DEFAULT_ACL_RULES, outboundRules: DEFAULT_ACL_RULES };
}

// ---------- VPC peering ----------

export const peeringConnection: ResourceTypeDef = {
  service: "networking",
  type: "peering-connection",
  label: "Peering connection",
  pluralLabel: "Peering connections",
  description:
    "A private link between two VPCs. The other side must accept it, then each side needs a route to the other's range. It isn't transitive: A↔B and B↔C doesn't connect A and C.",
  idPrefix: "pcx",
  notFoundCode: "InvalidVpcPeeringConnectionID.NotFound",
  notFoundMessage: (id) => `The vpcPeeringConnection ID '${id}' does not exist`,
  apiNoun: "vpcPeeringConnection",
  stateErrorCode: "InvalidStateTransition",
  iam: {
    create: "ec2:CreateVpcPeeringConnection",
    read: "ec2:DescribeVpcPeeringConnections",
    update: "ec2:CreateTags",
    delete: "ec2:DeleteVpcPeeringConnection",
    actions: { accept: "ec2:AcceptVpcPeeringConnection", reject: "ec2:RejectVpcPeeringConnection" },
    arn: ec2Arn("vpc-peering-connection"),
  },
  fields: [
    { key: "name", label: "Name tag", type: "string", maxLength: 255, placeholder: "app-to-shared" },
    { key: "vpcId", label: "Requester VPC", type: "ref", required: true, immutable: true, ref: { service: "networking", type: "vpc" }, param: "VpcId" },
    {
      key: "peerVpcId",
      label: "Accepter VPC",
      type: "ref",
      required: true,
      immutable: true,
      ref: { service: "networking", type: "vpc" },
      param: "PeerVpcId",
      description: "In this account and region. Its address range must not overlap the requester's.",
    },
  ],
  columns: [
    { label: "Requester", path: "attributes.requesterCidr", mono: true },
    { label: "Accepter", path: "attributes.accepterCidr", mono: true },
  ],
  lifecycle: {
    create: { state: "pending-acceptance" },
    actions: {
      accept: { label: "Accept request", from: ["pending-acceptance"], via: "provisioning", to: "active", afterMs: 2000, pastTense: "accepted" },
      reject: { label: "Reject request", from: ["pending-acceptance"], to: "rejected", pastTense: "rejected", destructive: true },
    },
    inactiveStates: ["rejected", "deleted", "failed"],
  },
  async validate({ config, existing, ctx }) {
    if (existing) return;
    if (config.vpcId === config.peerVpcId) throw new EngineError("InvalidParameterValue", "The requester VPC and the accepter VPC must be different.");
    const [a, b] = await Promise.all([ctx.get(String(config.vpcId)), ctx.get(String(config.peerVpcId))]);
    const ca = a ? parseCidr(String(a.config.cidrBlock)) : null;
    const cb = b ? parseCidr(String(b.config.cidrBlock)) : null;
    if (a && b && ca && cb && cidrOverlaps(ca, cb)) {
      throw new EngineError(
        "InvalidParameterValue",
        `The CIDR '${String(b.config.cidrBlock)}' of VPC '${b.id}' overlaps with the CIDR '${String(a.config.cidrBlock)}' of VPC '${a.id}'. Peered VPCs need address ranges that don't overlap.`,
      );
    }
    const pair = new Set([config.vpcId, config.peerVpcId]);
    const dup = (await ctx.list("networking", "peering-connection")).find(
      (p) => ["pending-acceptance", "provisioning", "active"].includes(p.state ?? "") && pair.has(p.config.vpcId) && pair.has(p.config.peerVpcId),
    );
    if (dup) throw new EngineError("VpcPeeringConnectionAlreadyExists", `A VPC peering connection already exists between ${String(config.vpcId)} and ${String(config.peerVpcId)}: ${dup.id}`);
  },
  async derive({ config, existing, ctx }) {
    if (existing) return existing.attributes;
    const [a, b] = await Promise.all([ctx.get(String(config.vpcId)), ctx.get(String(config.peerVpcId))]);
    return { requesterCidr: a?.config.cidrBlock ?? null, accepterCidr: b?.config.cidrBlock ?? null };
  },
};

// ---------- VPC endpoints ----------

const PREFIX_LISTS: Record<string, Record<string, string>> = {
  s3: { "us-east-1": "pl-63a5400a", "us-west-2": "pl-68a54001", "eu-west-1": "pl-6da54004", "ap-south-1": "pl-78a54011" },
  dynamodb: { "us-east-1": "pl-02cd2c6b", "us-west-2": "pl-00a54069", "eu-west-1": "pl-6fa54006", "ap-south-1": "pl-66a5400f" },
};
export const prefixListFor = (service: string, region: string) => PREFIX_LISTS[service]?.[region] ?? "pl-00000000";

export const vpcEndpoint: ResourceTypeDef = {
  service: "networking",
  type: "vpc-endpoint",
  label: "VPC endpoint",
  pluralLabel: "VPC endpoints",
  description:
    "A private way from your VPC to Amazon S3 (or DynamoDB) that never touches the internet: no NAT gateway or public IP needed, and no NAT data charges. It adds a route to the route tables you pick.",
  idPrefix: "vpce",
  notFoundCode: "InvalidVpcEndpointId.NotFound",
  notFoundMessage: (id) => `The Vpc Endpoint Id '${id}' does not exist`,
  apiNoun: "vpcEndpoint",
  iam: {
    create: "ec2:CreateVpcEndpoint",
    read: "ec2:DescribeVpcEndpoints",
    update: "ec2:ModifyVpcEndpoint",
    delete: "ec2:DeleteVpcEndpoints",
    arn: ec2Arn("vpc-endpoint"),
  },
  fields: [
    { key: "name", label: "Name tag", type: "string", maxLength: 255, placeholder: "s3-endpoint" },
    { key: "vpcId", label: "VPC", type: "ref", required: true, immutable: true, ref: { service: "networking", type: "vpc" }, param: "VpcId" },
    {
      key: "service",
      label: "Service",
      type: "enum",
      required: true,
      immutable: true,
      default: "s3",
      param: "ServiceName",
      options: [
        { value: "s3", label: "Amazon S3", hint: "com.amazonaws.<region>.s3 (gateway endpoint, free)" },
        { value: "dynamodb", label: "Amazon DynamoDB", hint: "com.amazonaws.<region>.dynamodb (gateway endpoint, free)" },
      ],
    },
    {
      key: "routeTableIds",
      label: "Route tables",
      type: "ref",
      ref: { service: "networking", type: "route-table", multiple: true, weak: true },
      param: "RouteTableIds",
      description: "Subnets using these route tables reach the service through the endpoint. Usually your private subnets' table.",
    },
  ],
  columns: [
    { label: "Service", path: "attributes.serviceName", mono: true },
    { label: "VPC", path: "config.vpcId", mono: true },
    { label: "Route tables", path: "attributes.routeTableCount" },
  ],
  lifecycle: { create: { state: "pending", settlesTo: "available", afterMs: 1500 } },
  async validate({ config, existing, ctx }) {
    const tables = (config.routeTableIds as string[] | undefined) ?? [];
    for (const id of tables) {
      const t = await ctx.get(id);
      if (t && t.config.vpcId !== config.vpcId) throw new EngineError("InvalidParameter", `Route table ${id} is not in VPC ${String(config.vpcId)}.`);
    }
    const others = (await ctx.list("networking", "vpc-endpoint")).filter((e) => e.id !== existing?.id && e.config.vpcId === config.vpcId && e.config.service === config.service);
    for (const e of others) {
      const clash = tables.find((t) => ((e.config.routeTableIds as string[] | undefined) ?? []).includes(t));
      if (clash) {
        throw new EngineError("RouteAlreadyExists", `route table ${clash} already has a route with destination-prefix-list-id ${prefixListFor(String(config.service), ctx.region)}`);
      }
    }
  },
  async derive({ config, ctx }) {
    return {
      serviceName: `com.amazonaws.${ctx.region}.${String(config.service)}`,
      prefixListId: prefixListFor(String(config.service), ctx.region),
      routeTableCount: ((config.routeTableIds as unknown[] | undefined) ?? []).length,
      endpointType: "Gateway",
    };
  },
};
