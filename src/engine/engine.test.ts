import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "./engine";
import { EngineError } from "./errors";
import { MemoryStore } from "./store";

const ACCOUNT = "acct-test";
const REGION = "us-east-1";

let clock: Date;
let engine: Engine;

function advance(ms: number) {
  clock = new Date(clock.getTime() + ms);
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof EngineError && e.code === code);
}

async function network() {
  const vpc = await engine.create(ACCOUNT, {
    service: "networking",
    type: "vpc",
    region: REGION,
    config: { name: "main", cidrBlock: "10.0.0.0/16" },
  });
  const subnet = await engine.create(ACCOUNT, {
    service: "networking",
    type: "subnet",
    region: REGION,
    config: { vpcId: vpc.id, cidrBlock: "10.0.1.0/24", availabilityZone: "us-east-1a", mapPublicIpOnLaunch: true },
  });
  const sg = await engine.create(ACCOUNT, {
    service: "networking",
    type: "security-group",
    region: REGION,
    config: {
      name: "web",
      description: "web",
      vpcId: vpc.id,
      inboundRules: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0" }],
    },
  });
  return { vpc, subnet, sg };
}

async function launch(subnetId: string, sgId: string) {
  return engine.create(ACCOUNT, {
    service: "compute",
    type: "instance",
    region: REGION,
    config: { imageId: "ami-0lab2023linux0001", instanceType: "t3.micro", subnetId, securityGroupIds: [sgId] },
  });
}

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("lifecycle", () => {
  it("settles a VPC from pending to available over time", async () => {
    const vpc = await engine.create(ACCOUNT, {
      service: "networking",
      type: "vpc",
      region: REGION,
      config: { cidrBlock: "10.0.0.0/16" },
    });
    expect(vpc.state).toBe("pending");
    advance(2000);
    expect((await engine.get(ACCOUNT, vpc.id)).state).toBe("available");
  });

  it("runs instance actions through transitional states", async () => {
    const { subnet, sg } = await network();
    const inst = await launch(subnet.id, sg.id);
    expect(inst.state).toBe("pending");
    await expectCode(engine.runAction(ACCOUNT, inst.id, "stop"), "IncorrectInstanceState");
    advance(8000);
    const stopping = await engine.runAction(ACCOUNT, inst.id, "stop");
    expect(stopping.state).toBe("stopping");
    advance(5000);
    expect((await engine.get(ACCOUNT, inst.id)).state).toBe("stopped");
  });
});

describe("networking rules", () => {
  it("canonicalizes host bits in a VPC CIDR, like the real API", async () => {
    const vpc = await engine.create(ACCOUNT, { service: "networking", type: "vpc", region: REGION, config: { cidrBlock: "10.0.0.5/16" } });
    expect(vpc.config.cidrBlock).toBe("10.0.0.0/16");
  });

  it("uses InvalidVpc.Range for VPCs outside /16–/28", async () => {
    await expectCode(
      engine.create(ACCOUNT, { service: "networking", type: "vpc", region: REGION, config: { cidrBlock: "10.0.0.0/8" } }),
      "InvalidVpc.Range",
    );
  });

  it("uses MissingParameter for missing required values", async () => {
    await expect(
      engine.create(ACCOUNT, { service: "networking", type: "security-group", region: REGION, config: { name: "x" } }),
    ).rejects.toMatchObject({ code: "MissingParameter", message: "The request must contain the parameter groupDescription" });
  });

  it("tells malformed IDs from missing ones", async () => {
    await expectCode(engine.getTyped(ACCOUNT, "vpc-nope", "networking", "vpc"), "InvalidVpcID.Malformed");
    await expect(engine.getTyped(ACCOUNT, "vpc-0123456789abcdef0", "networking", "vpc")).rejects.toMatchObject({
      code: "InvalidVpcID.NotFound",
      message: "The vpc ID 'vpc-0123456789abcdef0' does not exist",
    });
  });

  it("lists valid zones for an invalid availability zone", async () => {
    const { vpc } = await network();
    await expect(
      engine.create(ACCOUNT, {
        service: "networking",
        type: "subnet",
        region: REGION,
        config: { vpcId: vpc.id, cidrBlock: "10.0.9.0/24", availabilityZone: "us-east-1z" },
      }),
    ).rejects.toMatchObject({ code: "InvalidParameterValue", message: expect.stringContaining("us-east-1a, us-east-1b, us-east-1c") });
  });

  it("rejects subnets outside the VPC or overlapping each other", async () => {
    const { vpc } = await network();
    await expectCode(
      engine.create(ACCOUNT, {
        service: "networking",
        type: "subnet",
        region: REGION,
        config: { vpcId: vpc.id, cidrBlock: "172.16.0.0/24", availabilityZone: "us-east-1a" },
      }),
      "InvalidSubnet.Range",
    );
    await expectCode(
      engine.create(ACCOUNT, {
        service: "networking",
        type: "subnet",
        region: REGION,
        config: { vpcId: vpc.id, cidrBlock: "10.0.1.128/25", availabilityZone: "us-east-1b" },
      }),
      "InvalidSubnet.Conflict",
    );
  });

  it("blocks deleting a VPC that still has subnets", async () => {
    const { vpc } = await network();
    await expect(engine.remove(ACCOUNT, vpc.id)).rejects.toMatchObject({
      code: "DependencyViolation",
      message: `The vpc '${vpc.id}' has dependencies and cannot be deleted.`,
    });
  });

  it("removes a route table association when its subnet is deleted", async () => {
    const { vpc, subnet } = await network();
    const rt = await engine.create(ACCOUNT, {
      service: "networking",
      type: "route-table",
      region: REGION,
      config: { vpcId: vpc.id, subnetIds: [subnet.id] },
    });
    await engine.remove(ACCOUNT, subnet.id);
    expect((await engine.get(ACCOUNT, rt.id)).config.subnetIds).toEqual([]);
  });

  it("won't delete an attached internet gateway", async () => {
    const { vpc } = await network();
    const igw = await engine.create(ACCOUNT, { service: "networking", type: "internet-gateway", region: REGION, config: { vpcId: vpc.id } });
    await expectCode(engine.remove(ACCOUNT, igw.id), "DependencyViolation");
  });
});

describe("compute", () => {
  it("assigns private and public IPs from the subnet", async () => {
    const { subnet, sg } = await network();
    const a = await launch(subnet.id, sg.id);
    const b = await launch(subnet.id, sg.id);
    expect(a.attributes.privateIp).toBe("10.0.1.4");
    expect(b.attributes.privateIp).toBe("10.0.1.5");
    expect(a.attributes.publicIp).toMatch(/^203\.0\.113\./);
  });

  it("treats stopping an already stopped instance as a no-op, like the real API", async () => {
    const { subnet, sg } = await network();
    const inst = await launch(subnet.id, sg.id);
    advance(8000);
    await engine.runAction(ACCOUNT, inst.id, "stop");
    advance(5000);
    expect((await engine.runAction(ACCOUNT, inst.id, "stop")).state).toBe("stopped");
  });

  it("reports unknown and malformed AMIs like the real API", async () => {
    const { subnet, sg } = await network();
    const launchWith = (imageId: string) =>
      engine.create(ACCOUNT, {
        service: "compute",
        type: "instance",
        region: REGION,
        config: { imageId, subnetId: subnet.id, securityGroupIds: [sg.id] },
      });
    await expect(launchWith("ami-0123456789abcdef0")).rejects.toMatchObject({
      code: "InvalidAMIID.NotFound",
      message: "The image id '[ami-0123456789abcdef0]' does not exist",
    });
    await expectCode(launchWith("ubuntu"), "InvalidAMIID.Malformed");
  });

  it("rejects a security group from another VPC", async () => {
    const { subnet } = await network();
    const other = await engine.create(ACCOUNT, {
      service: "networking",
      type: "vpc",
      region: REGION,
      config: { cidrBlock: "10.1.0.0/16" },
    });
    const foreignSg = await engine.create(ACCOUNT, {
      service: "networking",
      type: "security-group",
      region: REGION,
      config: { name: "x", description: "x", vpcId: other.id },
    });
    await expectCode(launch(subnet.id, foreignSg.id), "InvalidParameter");
  });

  it("only allows instance type changes while stopped, and deletion once terminated", async () => {
    const { subnet, sg } = await network();
    const inst = await launch(subnet.id, sg.id);
    advance(8000);
    await expectCode(engine.update(ACCOUNT, inst.id, { instanceType: "t3.small" }), "IncorrectInstanceState");
    await expectCode(engine.remove(ACCOUNT, inst.id), "IncorrectInstanceState");
    await engine.runAction(ACCOUNT, inst.id, "terminate");
    advance(5000);
    await engine.remove(ACCOUNT, inst.id);
    await engine.remove(ACCOUNT, subnet.id);
  });
});

describe("storage", () => {
  it("enforces naming rules and global uniqueness", async () => {
    const create = (account: string, name: string) =>
      engine.create(account, { service: "storage", type: "bucket", region: REGION, config: { name } });
    await expectCode(create(ACCOUNT, "My_Bucket"), "InvalidBucketName");
    await expectCode(create(ACCOUNT, "192.168.1.1"), "InvalidBucketName");
    const b = await create(ACCOUNT, "my-assets");
    expect(b.id).toBe("my-assets");
    await expectCode(create(ACCOUNT, "my-assets"), "BucketAlreadyOwnedByYou");
    await expectCode(create("acct-other", "my-assets"), "BucketAlreadyExists");
  });

  it("does not allow versioning to be disabled after enabling", async () => {
    const b = await engine.create(ACCOUNT, {
      service: "storage",
      type: "bucket",
      region: REGION,
      config: { name: "versioned-bucket", versioning: "Enabled" },
    });
    await expectCode(engine.update(ACCOUNT, b.id, { versioning: "Disabled" }), "MalformedXML");
    expect((await engine.update(ACCOUNT, b.id, { versioning: "Suspended" })).config.versioning).toBe("Suspended");
  });
});
