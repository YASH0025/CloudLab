import { EngineError } from "@/engine/errors";
import { accountNumber } from "@/engine/ids";
import { aclFor, aclRules, type AclRule } from "@/engine/services/vpc-extras";
import { systemOf, type Resource } from "@/engine/types";
import type { Args, CliContext, Command } from "./commands";
import { parseShorthand, UsageError } from "./parse";
import { tags } from "./present";

/**
 * `aws ec2` for network ACLs, VPC peering connections and VPC endpoints.
 */

const cmd = (c: Command) => c;
const load = (ctx: CliContext, type: string, id: string) => ctx.engine.getTyped(ctx.accountId, id, "networking", type, ctx.region);
const listOf = (ctx: CliContext, service: string, type: string) => ctx.engine.list(ctx.accountId, { service, type, region: ctx.region });

function nameTag(args: Args): string | undefined {
  const all = args.raw("tag-specifications").join(" ");
  const m = /"?Key"?\s*[:=]\s*"?Name"?\s*,\s*"?Value"?\s*[:=]\s*"?([^"}\],]+)/.exec(all);
  return m?.[1]?.trim();
}

function filtered(args: Args, items: Resource[], pick: (r: Resource, name: string) => unknown): Resource[] {
  return args.raw("filters").reduce((acc, raw) => {
    const f = parseShorthand(raw);
    const values = ([] as string[]).concat(f.Values ?? []);
    return acc.filter((r) => values.includes(String(pick(r, String(f.Name ?? "")))));
  }, items);
}

// ---------- network ACLs ----------

const PROTOCOL_NUMBER: Record<string, string> = { all: "-1", tcp: "6", udp: "17", icmp: "1" };
const PROTOCOL_NAME: Record<string, AclRule["protocol"]> = { "-1": "all", all: "all", "6": "tcp", tcp: "tcp", "17": "udp", udp: "udp", "1": "icmp", icmp: "icmp" };
const aclAssociationId = (subnetId: string) => `aclassoc-${subnetId.replace(/^subnet-/, "")}`;

function entryOut(r: AclRule, egress: boolean) {
  return {
    CidrBlock: r.cidr,
    Egress: egress,
    Protocol: PROTOCOL_NUMBER[r.protocol],
    RuleAction: r.action,
    RuleNumber: r.ruleNumber,
    ...(r.protocol === "tcp" || r.protocol === "udp" ? { PortRange: { From: r.fromPort, To: r.toPort } } : {}),
    ...(r.protocol === "icmp" ? { IcmpTypeCode: { Code: -1, Type: -1 } } : {}),
  };
}

async function aclOut(ctx: CliContext, acl: Resource) {
  const [subnets, acls] = await Promise.all([listOf(ctx, "networking", "subnet"), listOf(ctx, "networking", "network-acl")]);
  const associated = subnets.filter((s) => s.config.vpcId === acl.config.vpcId && aclFor(s, acls)?.id === acl.id);
  const final = (egress: boolean) => ({ CidrBlock: "0.0.0.0/0", Egress: egress, Protocol: "-1", RuleAction: "deny", RuleNumber: 32767 });
  const t = tags(acl);
  return {
    Associations: associated.map((s) => ({ NetworkAclAssociationId: aclAssociationId(s.id), NetworkAclId: acl.id, SubnetId: s.id })),
    Entries: [
      ...aclRules(acl, true).map((r) => entryOut(r, true)),
      final(true),
      ...aclRules(acl, false).map((r) => entryOut(r, false)),
      final(false),
    ],
    IsDefault: systemOf(acl).isDefault === true,
    NetworkAclId: acl.id,
    ...(t ? { Tags: t } : {}),
    VpcId: acl.config.vpcId,
    OwnerId: accountNumber(ctx.accountId),
  };
}

/** --protocol, --port-range From=,To=, --cidr-block and --rule-action → a rule. */
function ruleFromArgs(args: Args): AclRule {
  const raw = args.required("protocol").toLowerCase();
  const protocol = PROTOCOL_NAME[raw];
  if (!protocol) throw new EngineError("InvalidParameterValue", `Invalid value '${raw}' for IP protocol. Unknown protocol.`);
  const action = args.required("rule-action").toLowerCase();
  if (action !== "allow" && action !== "deny") throw new EngineError("InvalidParameterValue", `Invalid value '${action}' for ruleAction. Valid values: allow, deny.`);
  const rangeRaw = args.raw("port-range").join(" ");
  const range = rangeRaw ? (parseShorthand(rangeRaw) as Record<string, string>) : undefined;
  if ((protocol === "tcp" || protocol === "udp") && !range) throw new EngineError("MissingParameter", "The request must contain the parameter portRange");
  return {
    ruleNumber: Number(args.required("rule-number")),
    protocol,
    ...(range ? { fromPort: Number(range.From), toPort: Number(range.To) } : {}),
    cidr: args.required("cidr-block"),
    action,
  };
}

const direction = (args: Args) => {
  if (args.has("egress") === args.has("ingress")) throw new UsageError("Specify exactly one of --ingress or --egress");
  return args.has("egress") ? "outboundRules" : "inboundRules";
};

// ---------- peering ----------

async function peeringOut(ctx: CliContext, p: Resource) {
  const [a, b] = await Promise.all([ctx.engine.get(ctx.accountId, String(p.config.vpcId)).catch(() => null), ctx.engine.get(ctx.accountId, String(p.config.peerVpcId)).catch(() => null)]);
  const owner = accountNumber(ctx.accountId);
  const t = tags(p);
  const status: Record<string, string> = {
    "pending-acceptance": "Pending Acceptance by " + owner,
    provisioning: "Provisioning",
    active: "Active",
    rejected: "Rejected by " + owner,
  };
  return {
    AccepterVpcInfo: { CidrBlock: b?.config.cidrBlock, OwnerId: owner, VpcId: p.config.peerVpcId, Region: ctx.region },
    RequesterVpcInfo: { CidrBlock: a?.config.cidrBlock, OwnerId: owner, VpcId: p.config.vpcId, Region: ctx.region },
    Status: { Code: p.state, Message: status[p.state ?? ""] ?? p.state },
    ...(t ? { Tags: t } : {}),
    VpcPeeringConnectionId: p.id,
  };
}

// ---------- endpoints ----------

function endpointOut(e: Resource, ctx: CliContext) {
  const t = tags(e);
  return {
    VpcEndpointId: e.id,
    VpcEndpointType: "Gateway",
    VpcId: e.config.vpcId,
    ServiceName: e.attributes.serviceName,
    State: e.state === "available" ? "available" : "pending",
    PolicyDocument: JSON.stringify({ Version: "2008-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "*", Resource: "*" }] }),
    RouteTableIds: (e.config.routeTableIds as string[] | undefined) ?? [],
    SubnetIds: [],
    Groups: [],
    PrivateDnsEnabled: false,
    RequesterManaged: false,
    NetworkInterfaceIds: [],
    DnsEntries: [],
    CreationTimestamp: e.createdAt,
    ...(t ? { Tags: t } : {}),
    OwnerId: accountNumber(ctx.accountId),
  };
}

const serviceFromName = (name: string, region: string) => {
  const m = new RegExp(`^com\\.amazonaws\\.${region.replace(/-/g, "\\-")}\\.(s3|dynamodb)$`).exec(name);
  if (!m) throw new EngineError("InvalidServiceName", `The Vpc Endpoint Service '${name}' does not exist`);
  return m[1];
};

export const VPC_EXTRA_COMMANDS: Command[] = [
  // --- network ACLs ---
  cmd({
    service: "ec2",
    operation: "create-network-acl",
    apiName: "CreateNetworkAcl",
    summary: "Create a network ACL (it denies everything until you add rules)",
    usage: "--vpc-id <id> [--tag-specifications <spec>]",
    mutates: true,
    async run(args, ctx) {
      const acl = await ctx.engine.create(ctx.accountId, { service: "networking", type: "network-acl", region: ctx.region, config: { name: nameTag(args), vpcId: args.required("vpc-id") } });
      return { NetworkAcl: await aclOut(ctx, acl) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-network-acls",
    apiName: "DescribeNetworkAcls",
    summary: "List network ACLs, their rules and subnets",
    usage: "[--network-acl-ids <id> ...] [--filters Name=vpc-id,Values=<id>]",
    mutates: false,
    async run(args, ctx) {
      const ids = args.list("network-acl-ids");
      const items = ids.length ? await Promise.all(ids.map((id) => load(ctx, "network-acl", id))) : await listOf(ctx, "networking", "network-acl");
      const shown = filtered(args, items, (r, n) => (n === "vpc-id" ? r.config.vpcId : n === "default" ? String(systemOf(r).isDefault === true) : n === "network-acl-id" ? r.id : undefined));
      return { NetworkAcls: await Promise.all(shown.map((a) => aclOut(ctx, a))) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "create-network-acl-entry",
    apiName: "CreateNetworkAclEntry",
    summary: "Add a numbered allow or deny rule to a network ACL",
    usage: "--network-acl-id <id> --rule-number <n> --protocol tcp|udp|icmp|-1 [--port-range From=<n>,To=<n>] --cidr-block <cidr> --rule-action allow|deny (--ingress | --egress)",
    mutates: true,
    async run(args, ctx) {
      const acl = await load(ctx, "network-acl", args.required("network-acl-id"));
      const key = direction(args);
      const rule = ruleFromArgs(args);
      await ctx.engine.update(ctx.accountId, acl.id, { [key]: [...((acl.config[key] as AclRule[] | undefined) ?? []), rule] });
    },
  }),
  cmd({
    service: "ec2",
    operation: "replace-network-acl-entry",
    apiName: "ReplaceNetworkAclEntry",
    summary: "Change an existing network ACL rule",
    usage: "--network-acl-id <id> --rule-number <n> --protocol tcp|udp|icmp|-1 [--port-range From=<n>,To=<n>] --cidr-block <cidr> --rule-action allow|deny (--ingress | --egress)",
    mutates: true,
    async run(args, ctx) {
      const acl = await load(ctx, "network-acl", args.required("network-acl-id"));
      const key = direction(args);
      const rule = ruleFromArgs(args);
      const rules = (acl.config[key] as AclRule[] | undefined) ?? [];
      if (!rules.some((r) => r.ruleNumber === rule.ruleNumber)) {
        throw new EngineError("InvalidNetworkAclEntry.NotFound", `The network acl entry identified by ${rule.ruleNumber} does not exist.`);
      }
      await ctx.engine.update(ctx.accountId, acl.id, { [key]: rules.map((r) => (r.ruleNumber === rule.ruleNumber ? rule : r)) });
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-network-acl-entry",
    apiName: "DeleteNetworkAclEntry",
    summary: "Remove a rule from a network ACL",
    usage: "--network-acl-id <id> --rule-number <n> (--ingress | --egress)",
    mutates: true,
    async run(args, ctx) {
      const acl = await load(ctx, "network-acl", args.required("network-acl-id"));
      const key = direction(args);
      const n = Number(args.required("rule-number"));
      const rules = (acl.config[key] as AclRule[] | undefined) ?? [];
      if (!rules.some((r) => r.ruleNumber === n)) throw new EngineError("InvalidNetworkAclEntry.NotFound", `The network acl entry identified by ${n} does not exist.`);
      await ctx.engine.update(ctx.accountId, acl.id, { [key]: rules.filter((r) => r.ruleNumber !== n) });
    },
  }),
  cmd({
    service: "ec2",
    operation: "replace-network-acl-association",
    apiName: "ReplaceNetworkAclAssociation",
    summary: "Move a subnet to another network ACL (find the association ID with describe-network-acls)",
    usage: "--association-id <aclassoc-id> --network-acl-id <id>",
    mutates: true,
    async run(args, ctx) {
      const assoc = args.required("association-id");
      const target = await load(ctx, "network-acl", args.required("network-acl-id"));
      const subnetId = `subnet-${assoc.replace(/^aclassoc-/, "")}`;
      const subnet = (await listOf(ctx, "networking", "subnet")).find((s) => s.id === subnetId);
      if (!subnet) throw new EngineError("InvalidAssociationID.NotFound", `The association ID '${assoc}' does not exist`);
      if (systemOf(target).isDefault) {
        // Back to the default ACL: take the subnet out of whichever custom ACL has it.
        for (const a of await listOf(ctx, "networking", "network-acl")) {
          const ids = (a.config.subnetIds as string[] | undefined) ?? [];
          if (ids.includes(subnetId)) await ctx.engine.update(ctx.accountId, a.id, { subnetIds: ids.filter((x) => x !== subnetId) });
        }
      } else {
        await ctx.engine.update(ctx.accountId, target.id, { subnetIds: [...((target.config.subnetIds as string[] | undefined) ?? []), subnetId] });
      }
      return { NewAssociationId: aclAssociationId(subnetId) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-network-acl",
    apiName: "DeleteNetworkAcl",
    summary: "Delete a network ACL (no subnets may use it)",
    usage: "--network-acl-id <id>",
    mutates: true,
    async run(args, ctx) {
      const acl = await load(ctx, "network-acl", args.required("network-acl-id"));
      await ctx.engine.remove(ctx.accountId, acl.id);
    },
  }),

  // --- peering ---
  cmd({
    service: "ec2",
    operation: "create-vpc-peering-connection",
    apiName: "CreateVpcPeeringConnection",
    summary: "Ask to connect two VPCs (the other side must accept)",
    usage: "--vpc-id <requester-vpc> --peer-vpc-id <accepter-vpc> [--peer-region <region>] [--tag-specifications <spec>]",
    mutates: true,
    async run(args, ctx) {
      if (args.one("peer-region") && args.one("peer-region") !== ctx.region) {
        throw new EngineError("InvalidParameterValue", "CloudLab peers VPCs in the same region only (inter-region peering isn't simulated yet).");
      }
      const p = await ctx.engine.create(ctx.accountId, {
        service: "networking",
        type: "peering-connection",
        region: ctx.region,
        config: { name: nameTag(args), vpcId: args.required("vpc-id"), peerVpcId: args.required("peer-vpc-id") },
      });
      return { VpcPeeringConnection: await peeringOut(ctx, p) };
    },
  }),
  ...(["accept", "reject"] as const).map((action) =>
    cmd({
      service: "ec2",
      operation: `${action}-vpc-peering-connection`,
      apiName: `${action === "accept" ? "Accept" : "Reject"}VpcPeeringConnection`,
      summary: action === "accept" ? "Accept a peering request" : "Turn down a peering request",
      usage: "--vpc-peering-connection-id <pcx-id>",
      mutates: true,
      async run(args: Args, ctx: CliContext) {
        const p = await load(ctx, "peering-connection", args.required("vpc-peering-connection-id"));
        if (p.state !== "pending-acceptance") {
          throw new EngineError("InvalidStateTransition", `Invalid state transition for pcx ${p.id}, attempted to transition from ${p.state} to ${action === "accept" ? "provisioning" : "rejected"}`);
        }
        const updated = await ctx.engine.runAction(ctx.accountId, p.id, action);
        return action === "accept" ? { VpcPeeringConnection: await peeringOut(ctx, updated) } : { Return: true };
      },
    }),
  ),
  cmd({
    service: "ec2",
    operation: "describe-vpc-peering-connections",
    apiName: "DescribeVpcPeeringConnections",
    summary: "List peering connections and their status",
    usage: "[--vpc-peering-connection-ids <id> ...]",
    mutates: false,
    async run(args, ctx) {
      const ids = args.list("vpc-peering-connection-ids");
      const items = ids.length ? await Promise.all(ids.map((id) => load(ctx, "peering-connection", id))) : await listOf(ctx, "networking", "peering-connection");
      return { VpcPeeringConnections: await Promise.all(items.map((p) => peeringOut(ctx, p))) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-vpc-peering-connection",
    apiName: "DeleteVpcPeeringConnection",
    summary: "Disconnect two VPCs (routes to it become blackholes)",
    usage: "--vpc-peering-connection-id <pcx-id>",
    mutates: true,
    async run(args, ctx) {
      const p = await load(ctx, "peering-connection", args.required("vpc-peering-connection-id"));
      await ctx.engine.remove(ctx.accountId, p.id);
      return { Return: true };
    },
  }),

  // --- endpoints ---
  cmd({
    service: "ec2",
    operation: "create-vpc-endpoint",
    apiName: "CreateVpcEndpoint",
    summary: "Create a gateway endpoint to S3 or DynamoDB for some route tables",
    usage: "--vpc-id <id> --service-name com.amazonaws.<region>.s3 [--route-table-ids <rtb-id> ...] [--vpc-endpoint-type Gateway]",
    mutates: true,
    async run(args, ctx) {
      const type = args.one("vpc-endpoint-type") ?? "Gateway";
      if (type !== "Gateway") throw new EngineError("InvalidParameter", "CloudLab simulates Gateway endpoints (S3 and DynamoDB) only; Interface endpoints aren't simulated yet.");
      const e = await ctx.engine.create(ctx.accountId, {
        service: "networking",
        type: "vpc-endpoint",
        region: ctx.region,
        config: { name: nameTag(args), vpcId: args.required("vpc-id"), service: serviceFromName(args.required("service-name"), ctx.region), routeTableIds: args.list("route-table-ids") },
      });
      return { VpcEndpoint: endpointOut(e, ctx) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-vpc-endpoints",
    apiName: "DescribeVpcEndpoints",
    summary: "List VPC endpoints",
    usage: "[--vpc-endpoint-ids <id> ...]",
    mutates: false,
    async run(args, ctx) {
      const ids = args.list("vpc-endpoint-ids");
      const items = ids.length ? await Promise.all(ids.map((id) => load(ctx, "vpc-endpoint", id))) : await listOf(ctx, "networking", "vpc-endpoint");
      return { VpcEndpoints: items.map((e) => endpointOut(e, ctx)) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "modify-vpc-endpoint",
    apiName: "ModifyVpcEndpoint",
    summary: "Add or remove route tables on a gateway endpoint",
    usage: "--vpc-endpoint-id <id> [--add-route-table-ids <rtb-id> ...] [--remove-route-table-ids <rtb-id> ...]",
    mutates: true,
    async run(args, ctx) {
      const e = await load(ctx, "vpc-endpoint", args.required("vpc-endpoint-id"));
      const remove = new Set(args.list("remove-route-table-ids"));
      const tables = [...new Set([...((e.config.routeTableIds as string[] | undefined) ?? []), ...args.list("add-route-table-ids")])].filter((t) => !remove.has(t));
      await ctx.engine.update(ctx.accountId, e.id, { routeTableIds: tables });
      return { Return: true };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-vpc-endpoints",
    apiName: "DeleteVpcEndpoints",
    summary: "Delete VPC endpoints",
    usage: "--vpc-endpoint-ids <id> ...",
    mutates: true,
    async run(args, ctx) {
      const ids = args.list("vpc-endpoint-ids");
      if (ids.length === 0) throw new UsageError("the following arguments are required: --vpc-endpoint-ids");
      const unsuccessful = [];
      for (const id of ids) {
        try {
          await ctx.engine.remove(ctx.accountId, (await load(ctx, "vpc-endpoint", id)).id);
        } catch (e) {
          unsuccessful.push({ Error: { Code: (e as EngineError).code ?? "InternalError", Message: (e as Error).message }, ResourceId: id });
        }
      }
      return { Unsuccessful: unsuccessful };
    },
  }),
];
