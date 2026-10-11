import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";

let clock: Date;
let engine: Engine;
const ACCOUNT = "acct-vpcx-cli";
const run = (line: string) => executeCli(line, { engine, accountId: ACCOUNT, region: "us-east-1" });
async function json(line: string) {
  const r = await run(line);
  if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
  return r.output ? JSON.parse(r.output) : {};
}
async function fails(line: string) {
  const r = await run(line);
  const m = /\(([^)]+)\) when calling the (\w+) operation: ([\s\S]*)/.exec(r.output);
  if (!m) throw new Error(r.output);
  return { code: m[1], message: m[3] };
}

beforeEach(() => {
  clock = new Date("2026-10-01T10:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("aws ec2: network ACLs, peering and endpoints", { timeout: 30_000 }, () => {
  it("manages network ACL rules and associations", async () => {
    const vpc = (await json("aws ec2 create-vpc --cidr-block 10.0.0.0/16")).Vpc.VpcId;
    const subnet = (await json(`aws ec2 create-subnet --vpc-id ${vpc} --cidr-block 10.0.1.0/24 --availability-zone us-east-1a`)).Subnet.SubnetId;
    const def = (await json(`aws ec2 describe-network-acls --filters Name=vpc-id,Values=${vpc}`)).NetworkAcls[0];
    expect(def).toMatchObject({ IsDefault: true, Associations: [{ SubnetId: subnet }] });
    expect(def.Entries.map((e: { RuleNumber: number; Egress: boolean; RuleAction: string }) => `${e.Egress ? "out" : "in"} ${e.RuleNumber} ${e.RuleAction}`)).toEqual([
      "out 100 allow",
      "out 32767 deny",
      "in 100 allow",
      "in 32767 deny",
    ]);

    const acl = (await json(`aws ec2 create-network-acl --vpc-id ${vpc}`)).NetworkAcl.NetworkAclId;
    await json(`aws ec2 create-network-acl-entry --network-acl-id ${acl} --ingress --rule-number 100 --protocol tcp --port-range From=80,To=80 --cidr-block 0.0.0.0/0 --rule-action allow`);
    expect(await fails(`aws ec2 create-network-acl-entry --network-acl-id ${acl} --ingress --rule-number 100 --protocol -1 --cidr-block 0.0.0.0/0 --rule-action deny`)).toMatchObject({
      code: "NetworkAclEntryAlreadyExists",
    });
    expect(await fails(`aws ec2 create-network-acl-entry --network-acl-id ${acl} --egress --rule-number 100 --protocol tcp --cidr-block 0.0.0.0/0 --rule-action allow`)).toMatchObject({
      code: "MissingParameter",
    });
    await json(`aws ec2 replace-network-acl-association --association-id ${def.Associations[0].NetworkAclAssociationId} --network-acl-id ${acl}`);
    expect((await json(`aws ec2 describe-network-acls --network-acl-ids ${acl}`)).NetworkAcls[0].Associations).toEqual([
      { NetworkAclAssociationId: def.Associations[0].NetworkAclAssociationId, NetworkAclId: acl, SubnetId: subnet },
    ]);
    expect(await fails(`aws ec2 delete-network-acl --network-acl-id ${acl}`)).toMatchObject({ code: "DependencyViolation" });
    expect(await fails(`aws ec2 delete-network-acl --network-acl-id ${def.NetworkAclId}`)).toMatchObject({ code: "InvalidParameterValue" });
  });

  it("peers VPCs and routes to the peering connection", async () => {
    const a = (await json("aws ec2 create-vpc --cidr-block 10.0.0.0/16")).Vpc.VpcId;
    const b = (await json("aws ec2 create-vpc --cidr-block 10.1.0.0/16")).Vpc.VpcId;
    const c = (await json("aws ec2 create-vpc --cidr-block 10.0.0.0/16")).Vpc.VpcId;
    expect((await fails(`aws ec2 create-vpc-peering-connection --vpc-id ${a} --peer-vpc-id ${c}`)).message).toContain("overlaps");
    const pcx = (await json(`aws ec2 create-vpc-peering-connection --vpc-id ${a} --peer-vpc-id ${b}`)).VpcPeeringConnection;
    expect(pcx.Status.Code).toBe("pending-acceptance");
    expect((await fails(`aws ec2 create-vpc-peering-connection --vpc-id ${b} --peer-vpc-id ${a}`)).code).toBe("VpcPeeringConnectionAlreadyExists");
    await json(`aws ec2 accept-vpc-peering-connection --vpc-peering-connection-id ${pcx.VpcPeeringConnectionId}`);
    expect((await fails(`aws ec2 accept-vpc-peering-connection --vpc-peering-connection-id ${pcx.VpcPeeringConnectionId}`)).code).toBe("InvalidStateTransition");
    clock = new Date(clock.getTime() + 3000);
    const rt = (await json(`aws ec2 create-route-table --vpc-id ${a}`)).RouteTable.RouteTableId;
    await json(`aws ec2 create-route --route-table-id ${rt} --destination-cidr-block 10.1.0.0/16 --vpc-peering-connection-id ${pcx.VpcPeeringConnectionId}`);
    const routes = (await json(`aws ec2 describe-route-tables --route-table-ids ${rt}`)).RouteTables[0].Routes;
    expect(routes[1]).toMatchObject({ DestinationCidrBlock: "10.1.0.0/16", VpcPeeringConnectionId: pcx.VpcPeeringConnectionId, State: "active" });

    const ep = (await json(`aws ec2 create-vpc-endpoint --vpc-id ${a} --service-name com.amazonaws.us-east-1.s3 --route-table-ids ${rt}`)).VpcEndpoint;
    expect(ep).toMatchObject({ VpcEndpointType: "Gateway", ServiceName: "com.amazonaws.us-east-1.s3", RouteTableIds: [rt] });
    const withEndpoint = (await json(`aws ec2 describe-route-tables --route-table-ids ${rt}`)).RouteTables[0].Routes;
    expect(withEndpoint.at(-1)).toMatchObject({ DestinationPrefixListId: "pl-63a5400a", GatewayId: ep.VpcEndpointId });
    expect((await fails(`aws ec2 create-vpc-endpoint --vpc-id ${a} --service-name com.amazonaws.us-east-1.sqs`)).code).toBe("InvalidServiceName");
    expect(await json(`aws ec2 delete-vpc-endpoints --vpc-endpoint-ids ${ep.VpcEndpointId}`)).toEqual({ Unsuccessful: [] });
  });
});
