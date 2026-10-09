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

    const missing = await run("aws ec2 describe-vpcs --vpc-ids vpc-nope");
    expect(missing.output).toContain("(InvalidVpcID.NotFound)");
  });

  it("reports usage errors with exit code 252", async () => {
    const r = await run("aws ec2 create-vpc");
    expect(r.exitCode).toBe(252);
    expect(r.output).toContain("the following arguments are required: --cidr-block");
    expect((await run("aws ec2 fly-to-moon")).exitCode).toBe(252);
    expect((await run("ls")).exitCode).toBe(127);
  });

  it("rejects duplicate security group rules", async () => {
    const vpc = (await json("aws ec2 create-vpc --cidr-block 10.0.0.0/16")).Vpc;
    const { GroupId } = await json(`aws ec2 create-security-group --group-name g --description d --vpc-id ${vpc.VpcId}`);
    const rule = `aws ec2 authorize-security-group-ingress --group-id ${GroupId} --protocol tcp --port 22 --cidr 0.0.0.0/0`;
    await json(rule);
    expect((await run(rule)).output).toContain("InvalidPermission.Duplicate");
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
