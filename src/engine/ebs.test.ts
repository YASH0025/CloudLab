import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "./engine";
import { filesOf, writeVolumeFile } from "./services/ebs";
import { MemoryStore } from "./store";
import type { Resource } from "./types";

const A = "acct-ebs";
const R = "us-east-1";
let clock: Date;
let engine: Engine;

const later = (ms = 10_000) => {
  clock = new Date(clock.getTime() + ms);
};
const create = (service: string, type: string, config: Record<string, unknown>, region = R) => engine.create(A, { service, type, region, config });
const get = (id: string) => engine.get(A, id);
const volumes = () => engine.list(A, { service: "compute", type: "volume", region: R });
const write = (id: string, path: string, content: string) =>
  writeVolumeFile(get, (vid, patch) => engine.setAttributes(A, vid, patch), id, { path, content }, clock);
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected an error");
};

async function server(az = "us-east-1a") {
  const vpc = (await engine.list(A, { service: "networking", type: "vpc", region: R }))[0] ?? (await create("networking", "vpc", { cidrBlock: "10.0.0.0/16" }));
  const subnets = await engine.list(A, { service: "networking", type: "subnet", region: R });
  const subnet =
    subnets.find((s) => s.config.availabilityZone === az) ??
    (await create("networking", "subnet", { vpcId: vpc.id, cidrBlock: `10.0.${az.endsWith("a") ? 1 : 2}.0/24`, availabilityZone: az }));
  const sg = (await engine.list(A, { service: "networking", type: "security-group", region: R })).find((g) => g.config.vpcId === vpc.id)!;
  const inst = await create("compute", "instance", { name: `web-${az.slice(-1)}`, imageId: "ami-0lab2023linux0001", subnetId: subnet.id, securityGroupIds: [sg.id] });
  later();
  return get(inst.id);
}

beforeEach(() => {
  clock = new Date("2026-10-01T10:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("EBS", () => {
  it("gives every instance a root volume, deleted when the instance terminates", async () => {
    const inst = await server();
    const [root] = await volumes();
    expect(root).toMatchObject({ state: "in-use", config: { instanceId: inst.id, device: "/dev/xvda", size: 8, volumeType: "gp3" } });
    expect(filesOf(root).map((f) => f.path)).toEqual(["/etc/os-release"]);
    expect(await fails(engine.remove(A, root.id))).toMatchObject({ code: "VolumeInUse", message: `Volume ${root.id} is currently attached to ${inst.id}` });
    expect(await fails(engine.update(A, root.id, { instanceId: null }))).toMatchObject({ code: "OperationNotPermitted" });

    await engine.runAction(A, inst.id, "terminate");
    later();
    await get(inst.id);
    expect(await volumes()).toEqual([]);
  });

  it("attaches data volumes in the same zone, keeps their files through termination, and restores snapshots anywhere", async () => {
    const web = await server("us-east-1a");
    const other = await server("us-east-1b");
    const data = await create("compute", "volume", { name: "app-data", availabilityZone: "us-east-1a", size: 10, volumeType: "gp3" });
    later(3000);
    expect((await get(data.id)).state).toBe("available");
    expect(await fails(write(data.id, "/data/orders.csv", "x"))).toMatchObject({ code: "IncorrectState" });

    expect(await fails(engine.update(A, data.id, { instanceId: other.id, device: "/dev/sdf" }))).toMatchObject({
      code: "InvalidVolume.ZoneMismatch",
      message: `The volume '${data.id}' is not in the same availability zone as instance '${other.id}'`,
    });
    expect(await fails(engine.update(A, data.id, { instanceId: web.id, device: "/dev/xvda" }))).toMatchObject({
      code: "InvalidParameterValue",
      message: "Invalid value '/dev/xvda' for unixDevice. Attachment point /dev/xvda is already in use",
    });
    expect(await fails(engine.update(A, data.id, { instanceId: web.id, device: "sdf" }))).toMatchObject({ message: "Value (sdf) for parameter device is invalid. sdf is not a valid EBS device name." });
    await engine.update(A, data.id, { instanceId: web.id, device: "/dev/sdf" });
    later(2000);
    expect((await get(data.id)).state).toBe("in-use");
    await write(data.id, "/data/orders.csv", "id,item\n1,book\n");

    const snap = await create("compute", "snapshot", { name: "before-upgrade", volumeId: data.id, description: "nightly" });
    await write(data.id, "/data/orders.csv", "oops, overwritten");
    later(5000);
    expect(await get(snap.id)).toMatchObject({ state: "completed", attributes: { volumeSize: 10 } });

    expect(await fails(engine.update(A, data.id, { size: 5 }))).toMatchObject({ message: "New size cannot be smaller than existing size" });
    await engine.update(A, data.id, { size: 20 });

    // Restore the backup in the other zone: the old data is back.
    expect(await fails(create("compute", "volume", { availabilityZone: "us-east-1b", size: 4, snapshotId: snap.id, volumeType: "gp3" }))).toMatchObject({
      message: `Volume of size 4 GiB is smaller than snapshot '${snap.id}', expect size >= 10 GiB`,
    });
    const restored = await create("compute", "volume", { availabilityZone: "us-east-1b", snapshotId: snap.id, volumeType: "gp3" });
    expect(restored.config.size).toBe(10);
    expect(filesOf(restored)[0].content).toBe("id,item\n1,book\n");

    // Terminating the server detaches the data volume, files intact.
    await engine.runAction(A, web.id, "terminate");
    later();
    await get(web.id);
    later(2000);
    const kept = await get(data.id);
    expect(kept.state).toBe("available");
    expect(kept.config.instanceId ?? null).toBeNull();
    expect(filesOf(kept)[0].content).toBe("oops, overwritten");
  });

  it("copies snapshots to another region, which is the only way to use them there", async () => {
    const vol = await create("compute", "volume", { availabilityZone: "us-east-1a", size: 8, volumeType: "gp2" });
    const snap = await create("compute", "snapshot", { volumeId: vol.id });
    expect(await fails(create("compute", "volume", { availabilityZone: "eu-west-1a", snapshotId: snap.id, volumeType: "gp3" }, "eu-west-1"))).toMatchObject({
      code: "InvalidSnapshot.NotFound",
    });
    expect(await fails(create("compute", "snapshot", { sourceSnapshotId: snap.id, sourceRegion: R }, "eu-west-1"))).toMatchObject({ code: "IncorrectState" });
    later(5000);
    const copy: Resource = await create("compute", "snapshot", { sourceSnapshotId: snap.id, sourceRegion: R, description: "DR copy" }, "eu-west-1");
    later(5000);
    const vol2 = await create("compute", "volume", { availabilityZone: "eu-west-1a", snapshotId: copy.id, volumeType: "gp3" }, "eu-west-1");
    expect(vol2.config.size).toBe(8);
    expect(await fails(create("compute", "volume", { availabilityZone: "us-east-1a", size: 20000, volumeType: "gp3" }))).toMatchObject({ code: "InvalidParameterValue" });
    expect(await fails(create("compute", "volume", { availabilityZone: "us-east-1a", size: 10, volumeType: "st1" }))).toMatchObject({
      message: "The volume size is invalid for st1 volumes: 125 through 16384.",
    });
  });
});
