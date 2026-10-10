import { beforeEach, describe, expect, it } from "vitest";
import { executeCli } from "@/cli/execute";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { analyzeReachability, type ReachabilityInput } from "./reachability";

const ACCOUNT = "acct-private";
let clock: Date;
let engine: Engine;
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const run = (line: string) => executeCli(line, { engine, accountId: ACCOUNT, region: "us-east-1" });
async function json(line: string) {
  const r = await run(line);
  if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
  return r.output ? JSON.parse(r.output) : {};
}
async function fails(line: string) {
  const r = await run(line);
  expect(r.exitCode, r.output).toBe(254);
  const m = /\(([^)]+)\) when calling the \w+ operation: (.*)/.exec(r.output)!;
  return { code: m[1], message: m[2] };
}
const check = (id: string, input: ReachabilityInput) => analyzeReachability(engine, ACCOUNT, id, input);
const failing = (r: { steps: { id: string; status: string }[] }) => r.steps.filter((s) => s.status === "fail").map((s) => s.id);

const IMAGE = "ami-0lab2023linux0001";

/** A VPC with a public subnet (internet gateway) and a private subnet with no route out yet. */
async function twoTierNetwork() {
  const vpc = (await json("aws ec2 create-vpc --cidr-block 10.0.0.0/16")).Vpc.VpcId;
  advance(2_000);
  const pub = (await json(`aws ec2 create-subnet --vpc-id ${vpc} --cidr-block 10.0.1.0/24`)).Subnet.SubnetId;
  const priv = (await json(`aws ec2 create-subnet --vpc-id ${vpc} --cidr-block 10.0.2.0/24`)).Subnet.SubnetId;
  const igw = (await json("aws ec2 create-internet-gateway")).InternetGateway.InternetGatewayId;
  await json(`aws ec2 attach-internet-gateway --internet-gateway-id ${igw} --vpc-id ${vpc}`);
  const pubRt = (await json(`aws ec2 create-route-table --vpc-id ${vpc}`)).RouteTable.RouteTableId;
  await json(`aws ec2 create-route --route-table-id ${pubRt} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igw}`);
  await json(`aws ec2 associate-route-table --route-table-id ${pubRt} --subnet-id ${pub}`);
  const privRt = (await json(`aws ec2 create-route-table --vpc-id ${vpc}`)).RouteTable.RouteTableId;
  await json(`aws ec2 associate-route-table --route-table-id ${privRt} --subnet-id ${priv}`);
  return { vpc, pub, priv, igw, pubRt, privRt };
}

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("NAT gateways", () => {
  it("gives a private server a way out, but no way in", async () => {
    const n = await twoTierNetwork();
    const sg = (await json(`aws ec2 create-security-group --group-name app --description app --vpc-id ${n.vpc}`)).GroupId;
    const app = (await json(`aws ec2 run-instances --image-id ${IMAGE} --subnet-id ${n.priv} --security-group-ids ${sg}`)).Instances[0];
    advance(10_000);
    expect(app.PublicIpAddress).toBeUndefined();

    const out = { direction: "outbound", protocol: "tcp", port: 443 } as const;
    expect(failing(await check(app.InstanceId, out))).toEqual(["route"]);

    const eip = await json("aws ec2 allocate-address");
    const created = (await json(`aws ec2 create-nat-gateway --subnet-id ${n.pub} --allocation-id ${eip.AllocationId}`)).NatGateway;
    expect(created).toMatchObject({ State: "pending", SubnetId: n.pub, VpcId: n.vpc, ConnectivityType: "public" });
    expect(created.NatGatewayId).toMatch(/^nat-[0-9a-f]{17}$/);
    expect(created.NatGatewayAddresses[0]).toMatchObject({ AllocationId: eip.AllocationId, PublicIp: eip.PublicIp, PrivateIp: "10.0.1.4" });
    const nat = created.NatGatewayId;
    await json(`aws ec2 create-route --route-table-id ${n.privRt} --destination-cidr-block 0.0.0.0/0 --nat-gateway-id ${nat}`);

    // Still being created.
    expect(failing(await check(app.InstanceId, out))).toEqual(["nat"]);
    advance(6_000);
    const ok = await check(app.InstanceId, out);
    expect(ok.reachable).toBe(true);
    expect(ok.steps.find((s) => s.id === "nat")?.detail).toContain(eip.PublicIp);

    // The internet can't start a connection in.
    const inbound = await check(app.InstanceId, { protocol: "tcp", port: 443 });
    expect(failing(inbound)).toEqual(expect.arrayContaining(["public-ip", "gateway"]));
    expect(inbound.steps.find((s) => s.id === "gateway")?.detail).toMatch(/NAT gateway only carries connections the subnet starts/);

    // The route table and Elastic IP show the NAT gateway.
    const rt = (await json(`aws ec2 describe-route-tables --route-table-ids ${n.privRt}`)).RouteTables[0];
    expect(rt.Routes).toContainEqual({ DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: nat, Origin: "CreateRoute", State: "active" });
    const addr = (await json(`aws ec2 describe-addresses --allocation-ids ${eip.AllocationId}`)).Addresses[0];
    expect(addr.PrivateIpAddress).toBe("10.0.1.4");
    expect(addr.AssociationId).toMatch(/^eipassoc-/);
    expect((await json(`aws ec2 describe-nat-gateways --filter Name=vpc-id,Values=${n.vpc}`)).NatGateways).toHaveLength(1);

    // The next instance in the public subnet skips the NAT gateway's address.
    const web = (await json(`aws ec2 run-instances --image-id ${IMAGE} --subnet-id ${n.pub}`)).Instances[0];
    expect(web.PrivateIpAddress).toBe("10.0.1.5");
  });

  it("needs a public subnet to work", async () => {
    const n = await twoTierNetwork();
    const eip = await json("aws ec2 allocate-address");
    // Wrongly placed in the private subnet.
    const nat = (await json(`aws ec2 create-nat-gateway --subnet-id ${n.priv} --allocation-id ${eip.AllocationId}`)).NatGateway.NatGatewayId;
    await json(`aws ec2 create-route --route-table-id ${n.privRt} --destination-cidr-block 0.0.0.0/0 --nat-gateway-id ${nat}`);
    const app = (await json(`aws ec2 run-instances --image-id ${IMAGE} --subnet-id ${n.priv}`)).Instances[0].InstanceId;
    advance(10_000);
    const r = await check(app, { direction: "outbound", protocol: "tcp", port: 443 });
    expect(failing(r)).toEqual(["nat-subnet"]);
  });

  it("fails like the real API", async () => {
    const n = await twoTierNetwork();
    const eip = await json("aws ec2 allocate-address");
    const lonelyVpc = (await json("aws ec2 create-vpc --cidr-block 10.9.0.0/16")).Vpc.VpcId;
    advance(2_000);
    const lonely = (await json(`aws ec2 create-subnet --vpc-id ${lonelyVpc} --cidr-block 10.9.1.0/24`)).Subnet.SubnetId;
    expect(await fails(`aws ec2 create-nat-gateway --subnet-id ${lonely} --allocation-id ${eip.AllocationId}`)).toEqual({
      code: "Gateway.NotAttached",
      message: `Network ${lonelyVpc} has no Internet gateway attached`,
    });

    const nat = (await json(`aws ec2 create-nat-gateway --subnet-id ${n.pub} --allocation-id ${eip.AllocationId}`)).NatGateway.NatGatewayId;
    expect(await fails(`aws ec2 create-nat-gateway --subnet-id ${n.pub} --allocation-id ${eip.AllocationId}`)).toEqual({
      code: "Resource.AlreadyAssociated",
      message: `Elastic IP address [${eip.AllocationId}] is already associated`,
    });
    expect((await fails(`aws ec2 release-address --allocation-id ${eip.AllocationId}`)).code).toBe("InvalidIPAddress.InUse");
    expect(await fails("aws ec2 delete-nat-gateway --nat-gateway-id nat-0123456789abcdef0")).toEqual({
      code: "NatGatewayNotFound",
      message: "The Nat Gateway nat-0123456789abcdef0 was not found",
    });
    expect((await fails("aws ec2 delete-nat-gateway --nat-gateway-id oops")).code).toBe("NatGatewayMalformed");
    expect((await fails(`aws ec2 create-route --route-table-id ${n.privRt} --destination-cidr-block 0.0.0.0/0`)).code).toBe(
      "MissingParameter",
    );
    expect((await fails(`aws ec2 delete-subnet --subnet-id ${n.pub}`)).code).toBe("DependencyViolation");
    expect((await fails(`aws ec2 detach-internet-gateway --internet-gateway-id ${n.igw} --vpc-id ${n.vpc}`)).code).toBe(
      "DependencyViolation",
    );

    // Deleting the gateway frees the address and leaves a blackhole route.
    await json(`aws ec2 create-route --route-table-id ${n.privRt} --destination-cidr-block 0.0.0.0/0 --nat-gateway-id ${nat}`);
    expect(await json(`aws ec2 delete-nat-gateway --nat-gateway-id ${nat}`)).toEqual({ NatGatewayId: nat });
    const rt = (await json(`aws ec2 describe-route-tables --route-table-ids ${n.privRt}`)).RouteTables[0];
    expect(rt.Routes.find((r: { NatGatewayId?: string }) => r.NatGatewayId)?.State).toBe("blackhole");
    // The route table can still be edited with the blackhole route in it.
    await json(`aws ec2 create-route --route-table-id ${n.privRt} --destination-cidr-block 192.168.0.0/16 --gateway-id ${n.igw}`);
    await json(`aws ec2 release-address --allocation-id ${eip.AllocationId}`);
  });
});

describe("instance to instance", () => {
  it("lets a bastion reach a private server only through security group chaining", async () => {
    const n = await twoTierNetwork();
    const bastionSg = (await json(`aws ec2 create-security-group --group-name bastion --description ssh --vpc-id ${n.vpc}`)).GroupId;
    await json(`aws ec2 authorize-security-group-ingress --group-id ${bastionSg} --protocol tcp --port 22 --cidr 0.0.0.0/0`);
    const appSg = (await json(`aws ec2 create-security-group --group-name app --description app --vpc-id ${n.vpc}`)).GroupId;
    const bastion = (
      await json(`aws ec2 run-instances --image-id ${IMAGE} --subnet-id ${n.pub} --security-group-ids ${bastionSg} --associate-public-ip-address`)
    ).Instances[0].InstanceId;
    const app = (await json(`aws ec2 run-instances --image-id ${IMAGE} --subnet-id ${n.priv} --security-group-ids ${appSg}`)).Instances[0]
      .InstanceId;
    advance(10_000);

    expect((await check(bastion, { protocol: "tcp", port: 22 })).reachable).toBe(true);
    const ssh = { from: bastion, protocol: "tcp", port: 22 } as const;
    const blocked = await check(app, ssh);
    expect(failing(blocked)).toEqual(["security-group"]);
    expect(blocked.steps.find((s) => s.id === "security-group")?.fix).toContain(`from security group ${bastionSg}`);

    await json(`aws ec2 authorize-security-group-ingress --group-id ${appSg} --protocol tcp --port 22 --source-group ${bastionSg}`);
    const ok = await check(app, ssh);
    expect(ok.reachable).toBe(true);
    expect(ok.target).toBe("10.0.2.4:22");
    expect(ok.steps.find((s) => s.id === "security-group")?.detail).toMatch(/security group chaining/);

    // Only members of the bastion group get in: the app server can't SSH to itself from another app server.
    const other = (await json(`aws ec2 run-instances --image-id ${IMAGE} --subnet-id ${n.priv} --security-group-ids ${appSg}`)).Instances[0]
      .InstanceId;
    advance(10_000);
    expect(failing(await check(app, { from: other, protocol: "tcp", port: 22 }))).toEqual(["security-group"]);
  });

  it("explains that separate VPCs can't talk", async () => {
    const a = (await json(`aws ec2 run-instances --image-id ${IMAGE}`)).Instances[0].InstanceId;
    const n = await twoTierNetwork();
    const b = (await json(`aws ec2 run-instances --image-id ${IMAGE} --subnet-id ${n.priv}`)).Instances[0].InstanceId;
    advance(10_000);
    expect(failing(await check(b, { from: a, protocol: "icmp" }))).toContain("same-vpc");
  });
});
