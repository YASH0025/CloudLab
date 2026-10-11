import { aclDecision, EPHEMERAL_PORT } from "@/engine/services/vpc-extras";
import type { Engine } from "@/engine/engine";
import { systemOf } from "@/engine/types";
import type { Suggestion } from "./types";

/**
 * Advisor rules for network ACLs and peering: a custom ACL that lets requests
 * in but blocks the replies, a peering connection routed on one side only,
 * and one still waiting to be accepted.
 */
export async function vpcxAdvice(engine: Engine, accountId: string, region: string) {
  const list = (type: string) => engine.list(accountId, { service: "networking", type, region });
  const [acls, peerings, tables] = await Promise.all([list("network-acl"), list("peering-connection"), list("route-table")]);
  const problems: Suggestion[] = [];
  const suggestions: Suggestion[] = [];

  for (const acl of acls) {
    if (systemOf(acl).isDefault || ((acl.config.subnetIds as string[] | undefined) ?? []).length === 0) continue;
    const inbound = (acl.config.inboundRules as { action: string; cidr: string; protocol: string }[] | undefined) ?? [];
    const servesInternet = inbound.some((r) => r.action === "allow" && r.cidr === "0.0.0.0/0" && r.protocol !== "icmp");
    if (!servesInternet || aclDecision(acl, true, "tcp", EPHEMERAL_PORT, "0.0.0.0/0").allowed) continue;
    problems.push({
      id: `acl-no-replies-${acl.id}`,
      level: "advanced",
      title: `${acl.name || acl.id} lets requests in but blocks the replies`,
      why: "It allows traffic in from the internet, but no outbound rule allows TCP 1024–65535, the ports visitors' replies go to. Network ACLs are stateless, so every connection through it times out.",
      steps: [`Edit ${acl.name || acl.id}: add an outbound rule allowing TCP 1024–65535 to 0.0.0.0/0.`],
      link: { service: "networking", type: "network-acl", mode: "detail", id: acl.id },
      cli: `aws ec2 create-network-acl-entry --network-acl-id ${acl.id} --egress --rule-number 120 --protocol tcp --port-range From=1024,To=65535 --cidr-block 0.0.0.0/0 --rule-action allow`,
    });
  }

  for (const p of peerings) {
    const link = { service: "networking", type: "peering-connection", mode: "detail" as const, id: p.id };
    if (p.state === "pending-acceptance") {
      suggestions.push({
        id: `pcx-pending-${p.id}`,
        level: "intermediate",
        title: `Peering connection ${p.name || p.id} is waiting to be accepted`,
        why: "Nothing flows between the two VPCs until the accepter VPC's owner accepts the request.",
        steps: [`Open ${p.name || p.id} and click Accept request.`],
        link,
        cli: `aws ec2 accept-vpc-peering-connection --vpc-peering-connection-id ${p.id}`,
      });
      continue;
    }
    if (p.state !== "active") continue;
    const routed = (vpcId: unknown) =>
      tables.some((t) => t.config.vpcId === vpcId && ((t.config.routes as { vpcPeeringConnectionId?: string }[] | undefined) ?? []).some((r) => r.vpcPeeringConnectionId === p.id));
    const there = routed(p.config.vpcId);
    const back = routed(p.config.peerVpcId);
    if (there !== back) {
      const missing = there ? p.config.peerVpcId : p.config.vpcId;
      problems.push({
        id: `pcx-one-way-${p.id}`,
        level: "intermediate",
        title: `${p.name || p.id} is only routed on one side`,
        why: `${String(missing)} has no route through it, so replies can't come back: connections across the peering time out.`,
        steps: [`In ${String(missing)}'s route table, add the other VPC's range → ${p.id}.`],
        link,
      });
    }
  }
  return { problems, suggestions };
}
