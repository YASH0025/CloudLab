import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";

let clock: Date;
let engine: Engine;
let store: MemoryStore;
const ctx = () => ({ engine, accountId: "acct-keys", region: "us-east-1" });
const run = (line: string) => executeCli(line, ctx());
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

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

const IMAGE = "ami-0lab2023linux0001";

/** Launches into the default VPC and waits until it's running. */
async function launch(extra = "") {
  const id = (await json(`aws ec2 run-instances --image-id ${IMAGE} ${extra}`)).Instances[0].InstanceId as string;
  advance(10_000);
  return id;
}

async function instance(id: string) {
  return (await json(`aws ec2 describe-instances --instance-ids ${id}`)).Reservations[0].Instances[0];
}

async function address(allocationId: string) {
  return (await json(`aws ec2 describe-addresses --allocation-ids ${allocationId}`)).Addresses[0];
}

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
  store = new MemoryStore();
  engine = new Engine(store, () => clock);
});

describe("key pairs", () => {
  it("returns the private key once and never stores it", async () => {
    const created = await json("aws ec2 create-key-pair --key-name my-key");
    expect(created.KeyName).toBe("my-key");
    expect(created.KeyPairId).toMatch(/^key-[0-9a-f]{17}$/);
    expect(created.KeyMaterial).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    expect(created.KeyFingerprint).toMatch(/^([0-9a-f]{2}:){19}[0-9a-f]{2}$/);

    const listed = (await json("aws ec2 describe-key-pairs")).KeyPairs;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ KeyName: "my-key", KeyType: "rsa", KeyFingerprint: created.KeyFingerprint });
    expect(listed[0].KeyMaterial).toBeUndefined();
    expect(listed[0].PublicKey).toBeUndefined();
    const stored = await store.get("acct-keys", created.KeyPairId);
    expect(stored!.attributes.keyMaterial).toBeUndefined();

    const withPublic = (await json("aws ec2 describe-key-pairs --key-names my-key --include-public-key")).KeyPairs[0];
    expect(withPublic.PublicKey).toMatch(/^ssh-rsa AAAAB3NzaC1yc2E\S+ my-key$/);
  });

  it("makes ED25519 keys in OpenSSH format", async () => {
    const created = await json("aws ec2 create-key-pair --key-name ed --key-type ed25519");
    expect(created.KeyMaterial).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    expect(created.KeyFingerprint).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it("supports --query and --output text, and saves `> file` as a download", async () => {
    const r = await run("aws ec2 create-key-pair --key-name k2 --query KeyMaterial --output text > k2.pem");
    expect(r.exitCode).toBe(0);
    expect(r.saveAs).toBe("k2.pem");
    expect(r.output).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
    expect(r.output).toMatch(/-----END RSA PRIVATE KEY-----\n?$/);
    expect((await run("aws ec2 describe-key-pairs --query KeyPairs[].KeyName --output text")).output).toBe("k2");
    expect((await run("aws ec2 describe-key-pairs --query 'KeyPairs[0].KeyName'")).output).toBe('"k2"');
    expect((await run("aws ec2 describe-key-pairs --query 'KeyPairs[0'")).exitCode).toBe(255);
  });

  it("rejects duplicates and unknown names like the real API", async () => {
    await json("aws ec2 create-key-pair --key-name dup");
    expect(await fails("aws ec2 create-key-pair --key-name dup")).toEqual({
      code: "InvalidKeyPair.Duplicate",
      message: "The keypair 'dup' already exists.",
    });
    expect(await fails("aws ec2 describe-key-pairs --key-names nope")).toEqual({
      code: "InvalidKeyPair.NotFound",
      message: "The key pair 'nope' does not exist",
    });
    expect(await fails(`aws ec2 run-instances --image-id ${IMAGE} --key-name nope`)).toEqual({
      code: "InvalidKeyPair.NotFound",
      message: "The key pair 'nope' does not exist",
    });
  });

  it("lets instances keep their key name after the key pair is deleted", async () => {
    await json("aws ec2 create-key-pair --key-name web");
    const id = await launch("--key-name web");
    expect((await instance(id)).KeyName).toBe("web");
    const deleted = await json("aws ec2 delete-key-pair --key-name web");
    expect(deleted.Return).toBe(true);
    expect(deleted.KeyPairId).toMatch(/^key-/);
    expect((await instance(id)).KeyName).toBe("web");
    // Deleting a name that doesn't exist succeeds quietly, as in AWS.
    expect(await json("aws ec2 delete-key-pair --key-name web")).toEqual({ Return: true });
    // The instance can still be changed.
    await json(`aws ec2 stop-instances --instance-ids ${id}`);
    advance(10_000);
    await json(`aws ec2 modify-instance-attribute --instance-id ${id} --instance-type t3.small`);
  });

  it("filters instances by key name", async () => {
    await json("aws ec2 create-key-pair --key-name a");
    const withKey = await launch("--key-name a");
    await launch();
    const found = await json("aws ec2 describe-instances --filters Name=key-name,Values=a");
    expect(found.Reservations.map((r: { Instances: { InstanceId: string }[] }) => r.Instances[0].InstanceId)).toEqual([withKey]);
  });
});

describe("Elastic IPs", () => {
  it("allocates, associates and keeps the address through stop and start", async () => {
    const id = await launch();
    const autoIp = (await instance(id)).PublicIpAddress;
    expect(autoIp).toMatch(/^203\.0\.113\.\d+$/);

    const eip = await json("aws ec2 allocate-address");
    expect(eip).toMatchObject({ Domain: "vpc", PublicIpv4Pool: "amazon", NetworkBorderGroup: "us-east-1" });
    expect(eip.AllocationId).toMatch(/^eipalloc-[0-9a-f]{17}$/);
    expect(eip.PublicIp).not.toBe(autoIp);

    const { AssociationId } = await json(`aws ec2 associate-address --instance-id ${id} --allocation-id ${eip.AllocationId}`);
    expect(AssociationId).toMatch(/^eipassoc-[0-9a-f]{17}$/);
    expect((await instance(id)).PublicIpAddress).toBe(eip.PublicIp);
    expect(await address(eip.AllocationId)).toMatchObject({ InstanceId: id, AssociationId, PrivateIpAddress: (await instance(id)).PrivateIpAddress });

    await json(`aws ec2 stop-instances --instance-ids ${id}`);
    advance(10_000);
    expect((await instance(id)).PublicIpAddress).toBe(eip.PublicIp);
    await json(`aws ec2 start-instances --instance-ids ${id}`);
    advance(10_000);
    expect((await instance(id)).PublicIpAddress).toBe(eip.PublicIp);

    // Disassociating gives the instance a fresh automatic address.
    await json(`aws ec2 disassociate-address --association-id ${AssociationId}`);
    const after = (await instance(id)).PublicIpAddress;
    expect(after).toMatch(/^203\.0\.113\.\d+$/);
    expect(after).not.toBe(eip.PublicIp);
    expect((await address(eip.AllocationId)).InstanceId).toBeUndefined();
  });

  it("changes an automatic public IP on stop and start", async () => {
    const id = await launch();
    const first = (await instance(id)).PublicIpAddress;
    await json(`aws ec2 stop-instances --instance-ids ${id}`);
    advance(10_000);
    expect((await instance(id)).PublicIpAddress).toBeUndefined();
    await json(`aws ec2 start-instances --instance-ids ${id}`);
    expect((await instance(id)).PublicIpAddress).toBeUndefined();
    advance(10_000);
    const second = (await instance(id)).PublicIpAddress;
    expect(second).toMatch(/^203\.0\.113\.\d+$/);
    expect(second).not.toBe(first);
  });

  it("refuses to move an associated address unless reassociation is allowed", async () => {
    const a = await launch();
    const b = await launch();
    const eip = await json("aws ec2 allocate-address");
    const { AssociationId } = await json(`aws ec2 associate-address --instance-id ${a} --allocation-id ${eip.AllocationId}`);
    expect(await fails(`aws ec2 associate-address --instance-id ${b} --allocation-id ${eip.AllocationId}`)).toEqual({
      code: "Resource.AlreadyAssociated",
      message: `resource ${eip.AllocationId} is already associated with associate-id ${AssociationId}`,
    });
    await json(`aws ec2 associate-address --instance-id ${b} --allocation-id ${eip.AllocationId} --allow-reassociation`);
    expect((await instance(b)).PublicIpAddress).toBe(eip.PublicIp);
    expect((await instance(a)).PublicIpAddress).toMatch(/^203\.0\.113\.\d+$/);
    expect((await instance(a)).PublicIpAddress).not.toBe(eip.PublicIp);
  });

  it("replaces an instance's existing Elastic IP with the new one", async () => {
    const id = await launch();
    const first = await json("aws ec2 allocate-address");
    const second = await json("aws ec2 allocate-address");
    await json(`aws ec2 associate-address --instance-id ${id} --allocation-id ${first.AllocationId}`);
    await json(`aws ec2 associate-address --instance-id ${id} --allocation-id ${second.AllocationId}`);
    expect((await instance(id)).PublicIpAddress).toBe(second.PublicIp);
    expect((await address(first.AllocationId)).InstanceId).toBeUndefined();
  });

  it("needs an internet gateway on the instance's VPC", async () => {
    const vpc = (await json("aws ec2 create-vpc --cidr-block 10.0.0.0/16")).Vpc.VpcId;
    advance(2_000);
    const subnet = (await json(`aws ec2 create-subnet --vpc-id ${vpc} --cidr-block 10.0.1.0/24`)).Subnet.SubnetId;
    const id = await launch(`--subnet-id ${subnet}`);
    const eip = await json("aws ec2 allocate-address");
    expect(await fails(`aws ec2 associate-address --instance-id ${id} --allocation-id ${eip.AllocationId}`)).toEqual({
      code: "Gateway.NotAttached",
      message: `Network ${vpc} is not attached to any internet gateway`,
    });

    const igw = (await json("aws ec2 create-internet-gateway")).InternetGateway.InternetGatewayId;
    await json(`aws ec2 attach-internet-gateway --internet-gateway-id ${igw} --vpc-id ${vpc}`);
    await json(`aws ec2 associate-address --instance-id ${id} --allocation-id ${eip.AllocationId}`);
    expect((await instance(id)).PublicIpAddress).toBe(eip.PublicIp);

    // The gateway can't be detached while the address is mapped.
    expect((await fails(`aws ec2 detach-internet-gateway --internet-gateway-id ${igw} --vpc-id ${vpc}`)).code).toBe("DependencyViolation");
    // Outside the default VPC, an associated address must be disassociated before release.
    expect(await fails(`aws ec2 release-address --allocation-id ${eip.AllocationId}`)).toEqual({
      code: "InvalidIPAddress.InUse",
      message: `Address ${eip.PublicIp} is in use.`,
    });
  });

  it("releases an associated address in the default VPC and takes it off the instance", async () => {
    const id = await launch();
    const eip = await json("aws ec2 allocate-address");
    await json(`aws ec2 associate-address --instance-id ${id} --allocation-id ${eip.AllocationId}`);
    await json(`aws ec2 release-address --allocation-id ${eip.AllocationId}`);
    expect((await json("aws ec2 describe-addresses")).Addresses).toHaveLength(0);
    const ip = (await instance(id)).PublicIpAddress;
    expect(ip).toMatch(/^203\.0\.113\.\d+$/);
    expect(ip).not.toBe(eip.PublicIp);
  });

  it("disassociates when the instance terminates, keeping the address", async () => {
    const id = await launch();
    const eip = await json("aws ec2 allocate-address");
    await json(`aws ec2 associate-address --instance-id ${id} --allocation-id ${eip.AllocationId}`);
    await json(`aws ec2 terminate-instances --instance-ids ${id}`);
    advance(10_000);
    expect((await instance(id)).PublicIpAddress).toBeUndefined();
    const after = await address(eip.AllocationId);
    expect(after.PublicIp).toBe(eip.PublicIp);
    expect(after.InstanceId).toBeUndefined();
  });

  it("only associates with running or stopped instances", async () => {
    const id = (await json(`aws ec2 run-instances --image-id ${IMAGE}`)).Instances[0].InstanceId;
    const eip = await json("aws ec2 allocate-address");
    expect(await fails(`aws ec2 associate-address --instance-id ${id} --allocation-id ${eip.AllocationId}`)).toEqual({
      code: "IncorrectInstanceState",
      message: `The instance '${id}' is not in a valid state for this operation.`,
    });
  });

  it("enforces the address limit and gives the real errors for bad IDs", async () => {
    for (let i = 0; i < 5; i++) await json("aws ec2 allocate-address");
    expect(await fails("aws ec2 allocate-address")).toEqual({
      code: "AddressLimitExceeded",
      message: "The maximum number of addresses has been reached.",
    });
    expect(await fails("aws ec2 release-address --allocation-id eipalloc-0123456789abcdef0")).toEqual({
      code: "InvalidAllocationID.NotFound",
      message: "The allocation ID 'eipalloc-0123456789abcdef0' does not exist",
    });
    expect((await fails("aws ec2 release-address --allocation-id 1.2.3.4")).code).toBe("InvalidAllocationID.Malformed");
    expect((await fails("aws ec2 disassociate-address --association-id eipassoc-0123456789abcdef0")).code).toBe(
      "InvalidAssociationID.NotFound",
    );
    expect((await fails("aws ec2 describe-addresses --public-ips 198.51.100.1")).code).toBe("InvalidAddress.NotFound");
  });
});
