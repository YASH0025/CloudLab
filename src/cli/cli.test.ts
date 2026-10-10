import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";
import { parseAws, parseShorthand, tokenize } from "./parse";

let clock: Date;
let engine: Engine;
const ctx = () => ({ engine, accountId: "acct-cli", region: "us-east-1" });

async function run(line: string) {
  return executeCli(line, ctx());
}

async function json(line: string) {
  const r = await run(line);
  if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
  return JSON.parse(r.output);
}

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("parsing", () => {
  it("tokenizes quotes and escapes like a shell", () => {
    expect(tokenize(`aws ec2 x --description "web servers" --name 'a b' c\\ d`)).toEqual([
      "aws", "ec2", "x", "--description", "web servers", "--name", "a b", "c d",
    ]);
  });

  it("collects multi-value options and the global --region", () => {
    const p = parseAws(tokenize("aws --region eu-west-1 ec2 stop-instances --instance-ids i-1 i-2"));
    expect(p.region).toBe("eu-west-1");
    expect(p.options.get("instance-ids")).toEqual(["i-1", "i-2"]);
  });

  it("parses shorthand", () => {
    expect(parseShorthand("Name=vpc-id,Values=vpc-1,vpc-2")).toEqual({ Name: "vpc-id", Values: ["vpc-1", "vpc-2"] });
  });
});

describe("commands", () => {
  it("builds a public web server end to end", async () => {
    const vpc = (await json(
      "aws ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=main}]'",
    )).Vpc;
    expect(vpc.State).toBe("pending");
    expect(vpc.Tags).toEqual([{ Key: "Name", Value: "main" }]);

    const subnet = (await json(`aws ec2 create-subnet --vpc-id ${vpc.VpcId} --cidr-block 10.0.1.0/24`)).Subnet;
    expect(subnet.AvailabilityZone).toBe("us-east-1a");
    await run(`aws ec2 modify-subnet-attribute --subnet-id ${subnet.SubnetId} --map-public-ip-on-launch`);

    const igw = (await json("aws ec2 create-internet-gateway")).InternetGateway;
    await run(`aws ec2 attach-internet-gateway --internet-gateway-id ${igw.InternetGatewayId} --vpc-id ${vpc.VpcId}`);
    const rt = (await json(`aws ec2 create-route-table --vpc-id ${vpc.VpcId}`)).RouteTable;
    await json(
      `aws ec2 create-route --route-table-id ${rt.RouteTableId} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igw.InternetGatewayId}`,
    );
    const assoc = await json(`aws ec2 associate-route-table --route-table-id ${rt.RouteTableId} --subnet-id ${subnet.SubnetId}`);
    expect(assoc.AssociationId).toMatch(/^rtbassoc-/);

    const { GroupId } = await json(`aws ec2 create-security-group --group-name web --description "web" --vpc-id ${vpc.VpcId}`);
    await json(`aws ec2 authorize-security-group-ingress --group-id ${GroupId} --protocol tcp --port 80 --cidr 0.0.0.0/0`);

    const res = await json(
      `aws ec2 run-instances --image-id ami-0lab2023linux0001 --subnet-id ${subnet.SubnetId} --security-group-ids ${GroupId}`,
    );
    const inst = res.Instances[0];
    expect(inst.State).toEqual({ Code: 0, Name: "pending" });
    expect(inst.PublicIpAddress).toMatch(/^203\.0\.113\./);

    clock = new Date(clock.getTime() + 10_000);
    const described = await json(`aws ec2 describe-instances --filters Name=instance-state-name,Values=running`);
    expect(described.Reservations).toHaveLength(1);

    const tables = await json(`aws ec2 describe-route-tables --route-table-ids ${rt.RouteTableId}`);
    expect(tables.RouteTables[0].Routes.map((r: { GatewayId: string }) => r.GatewayId)).toEqual([
      "local",
      igw.InternetGatewayId,
    ]);

    const stop = await json(`aws ec2 stop-instances --instance-ids ${inst.InstanceId}`);
    expect(stop.StoppingInstances[0].CurrentState).toEqual({ Code: 64, Name: "stopping" });
  });

  it("formats service errors like the real CLI", async () => {
    const vpc = (await json("aws ec2 create-vpc --cidr-block 10.0.0.0/16")).Vpc;
    await json(`aws ec2 create-subnet --vpc-id ${vpc.VpcId} --cidr-block 10.0.1.0/24`);
    const r = await run(`aws ec2 delete-vpc --vpc-id ${vpc.VpcId}`);
    expect(r.exitCode).toBe(254);
    expect(r.output).toContain("An error occurred (DependencyViolation) when calling the DeleteVpc operation");

    const missing = await run("aws ec2 describe-vpcs --vpc-ids vpc-0123456789abcdef0");
    expect(missing.output).toContain(
      "An error occurred (InvalidVpcID.NotFound) when calling the DescribeVpcs operation: The vpc ID 'vpc-0123456789abcdef0' does not exist",
    );
    const malformed = await run("aws ec2 describe-vpcs --vpc-ids vpc-nope");
    expect(malformed.output).toContain('(InvalidVpcID.Malformed) when calling the DescribeVpcs operation: Invalid id: "vpc-nope"');
  });

  it("reports usage errors with exit code 252", async () => {
    const r = await run("aws ec2 create-subnet --cidr-block 10.0.1.0/24");
    expect(r.exitCode).toBe(252);
    expect(r.output).toContain("aws: error: the following arguments are required: --vpc-id");
    const unknown = await run("aws ec2 describe-vpcs --colour red");
    expect(unknown.exitCode).toBe(252);
    expect(unknown.output).toContain("Unknown options: --colour");
    expect((await run("aws ec2 fly-to-moon")).exitCode).toBe(252);
    expect((await run("ls")).exitCode).toBe(127);
  });

  it("lets the API, not the CLI, require create-vpc's CIDR, as the real CLI does", async () => {
    const r = await run("aws ec2 create-vpc");
    expect(r.exitCode).toBe(254);
    expect(r.output).toContain("(MissingParameter) when calling the CreateVpc operation: Either 'cidrBlock' or 'ipv4IpamPoolId' should be provided.");
  });

  it("supports --dry-run", async () => {
    const r = await run("aws ec2 create-vpc --cidr-block 10.0.0.0/16 --dry-run");
    expect(r.output).toContain("(DryRunOperation) when calling the CreateVpc operation: Request would have succeeded, but DryRun flag is set.");
    expect(r.changed).toBe(false);
  });

  it("rejects duplicate security group rules", async () => {
    const vpc = (await json("aws ec2 create-vpc --cidr-block 10.0.0.0/16")).Vpc;
    const { GroupId } = await json(`aws ec2 create-security-group --group-name g --description d --vpc-id ${vpc.VpcId}`);
    const rule = `aws ec2 authorize-security-group-ingress --group-id ${GroupId} --protocol tcp --port 22 --cidr 0.0.0.0/0`;
    await json(rule);
    expect((await run(rule)).output).toContain(
      'An error occurred (InvalidPermission.Duplicate) when calling the AuthorizeSecurityGroupIngress operation: the specified rule "peer: 0.0.0.0/0, TCP, from port: 22, to port: 22, ALLOW" already exists',
    );
  });

  it("handles s3 high-level and api commands", async () => {
    expect((await run("aws s3 mb s3://lab-bucket-1")).output).toBe("make_bucket: lab-bucket-1");
    expect((await run("aws s3 mb s3://lab-bucket-1")).output).toContain("BucketAlreadyOwnedByYou");
    expect((await run("aws s3 ls")).output).toContain("lab-bucket-1");
    await run("aws s3api put-bucket-versioning --bucket lab-bucket-1 --versioning-configuration Status=Enabled");
    expect(await json("aws s3api get-bucket-versioning --bucket lab-bucket-1")).toEqual({ Status: "Enabled" });
    expect((await run("aws s3 rb s3://lab-bucket-1")).output).toBe("remove_bucket: lab-bucket-1");
  });

  it("keeps regions separate", async () => {
    const vpc = (await json("aws ec2 create-vpc --cidr-block 10.0.0.0/16")).Vpc;
    const other = await run(`aws ec2 describe-vpcs --vpc-ids ${vpc.VpcId} --region eu-west-1`);
    expect(other.output).toContain("InvalidVpcID.NotFound");
    expect((await run("aws ec2 describe-vpcs --region mars-1")).exitCode).toBe(255);
  });
});

describe("default VPC in the CLI", () => {
  it("launches into the default VPC when no subnet or group is given", async () => {
    const vpcs = await json("aws ec2 describe-vpcs --filters Name=isDefault,Values=true");
    expect(vpcs.Vpcs).toHaveLength(1);
    expect(vpcs.Vpcs[0]).toMatchObject({ CidrBlock: "172.31.0.0/16", IsDefault: true });
    const res = await json("aws ec2 run-instances --image-id ami-0lab2023linux0001");
    const inst = res.Instances[0];
    expect(inst.VpcId).toBe(vpcs.Vpcs[0].VpcId);
    expect(inst.PublicIpAddress).toMatch(/^203\.0\.113\./);
    expect(inst.SecurityGroups[0].GroupName).toBe("default");
    const subnets = await json("aws ec2 describe-subnets --filters Name=default-for-az,Values=true");
    expect(subnets.Subnets).toHaveLength(3);
  });

  it("shows the main route table and refuses to delete the default security group", async () => {
    const tables = await json("aws ec2 describe-route-tables --filters Name=association.main,Values=true");
    expect(tables.RouteTables[0].Associations[0].Main).toBe(true);
    const groups = await json("aws ec2 describe-security-groups --filters Name=group-name,Values=default");
    const sg = groups.SecurityGroups[0];
    expect(sg.IpPermissions[0].UserIdGroupPairs[0].GroupId).toBe(sg.GroupId);
    const r = await run(`aws ec2 delete-security-group --group-id ${sg.GroupId}`);
    expect(r.output).toContain("(CannotDelete) when calling the DeleteSecurityGroup operation");
  });

  it("allows only one default VPC, and create-default-vpc brings a deleted one back", async () => {
    expect((await run("aws ec2 create-default-vpc")).output).toContain("(DefaultVpcAlreadyExists)");
    const vpc = (await json("aws ec2 describe-vpcs --filters Name=isDefault,Values=true")).Vpcs[0].VpcId;
    // Empty it the way a learner would, then delete it.
    for (const s of (await json("aws ec2 describe-subnets")).Subnets) await json(`aws ec2 delete-subnet --subnet-id ${s.SubnetId}`).catch(() => {});
    const igw = (await json("aws ec2 describe-internet-gateways")).InternetGateways[0].InternetGatewayId;
    await run(`aws ec2 detach-internet-gateway --internet-gateway-id ${igw} --vpc-id ${vpc}`);
    await run(`aws ec2 delete-internet-gateway --internet-gateway-id ${igw}`);
    expect((await run(`aws ec2 delete-vpc --vpc-id ${vpc}`)).exitCode).toBe(0);
    expect((await json("aws ec2 create-default-vpc")).Vpc.IsDefault).toBe(true);
  });

  it("accepts a source security group in rules", async () => {
    const { GroupId: web } = await json("aws ec2 create-security-group --group-name web --description web");
    const { GroupId: db } = await json("aws ec2 create-security-group --group-name db --description db");
    await json(`aws ec2 authorize-security-group-ingress --group-id ${db} --protocol tcp --port 5432 --source-group ${web}`);
    const out = await json(`aws ec2 describe-security-groups --group-ids ${db}`);
    expect(out.SecurityGroups[0].IpPermissions[0]).toMatchObject({ FromPort: 5432, UserIdGroupPairs: [{ GroupId: web }] });
    expect((await run(`aws ec2 authorize-security-group-ingress --group-id ${db} --protocol tcp --port 22`)).output).toContain(
      "(MissingParameter)",
    );
  });
});
