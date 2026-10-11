import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";

let clock: Date;
let engine: Engine;
const ACCOUNT = "acct-ebs-cli";
const run = (line: string, region = "us-east-1") => executeCli(line, { engine, accountId: ACCOUNT, region });
async function json(line: string, region?: string) {
  const r = await run(line, region);
  if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
  return r.output ? JSON.parse(r.output) : {};
}
async function fails(line: string) {
  const r = await run(line);
  const m = /\(([^)]+)\) when calling the (\w+) operation: ([\s\S]*)/.exec(r.output);
  if (!m) throw new Error(r.output);
  return { code: m[1], message: m[3] };
}
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

beforeEach(() => {
  clock = new Date("2026-10-01T10:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("aws ec2: EBS", { timeout: 30_000 }, () => {
  it("creates, attaches, grows, snapshots, copies and deletes volumes", async () => {
    const subnet = (await json("aws ec2 describe-subnets --filters Name=default-for-az,Values=true")).Subnets.find((s: { AvailabilityZone: string }) => s.AvailabilityZone === "us-east-1a");
    const inst = (await json(`aws ec2 run-instances --image-id ami-0lab2023linux0001 --instance-type t3.micro --subnet-id ${subnet.SubnetId}`)).Instances[0].InstanceId;
    later(10_000);
    const root = (await json(`aws ec2 describe-volumes --filters Name=attachment.instance-id,Values=${inst}`)).Volumes;
    expect(root).toHaveLength(1);
    expect(root[0].Attachments[0]).toMatchObject({ Device: "/dev/xvda", State: "attached", DeleteOnTermination: true });

    const vol = await json(`aws ec2 create-volume --availability-zone us-east-1a --size 10 --volume-type gp3 --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=data}]'`);
    expect(vol).toMatchObject({ State: "creating", Size: 10, VolumeType: "gp3", Iops: 3000, Tags: [{ Key: "Name", Value: "data" }] });
    expect(await fails(`aws ec2 attach-volume --volume-id ${vol.VolumeId} --instance-id ${inst} --device /dev/sdf`)).toMatchObject({ code: "IncorrectState" });
    later(3000);
    expect(await json(`aws ec2 attach-volume --volume-id ${vol.VolumeId} --instance-id ${inst} --device /dev/sdf`)).toMatchObject({ State: "attaching", Device: "/dev/sdf" });
    expect(await fails(`aws ec2 delete-volume --volume-id ${vol.VolumeId}`)).toMatchObject({ code: "VolumeInUse" });
    expect((await json(`aws ec2 modify-volume --volume-id ${vol.VolumeId} --size 20`)).VolumeModification).toMatchObject({ OriginalSize: 10, TargetSize: 20 });

    const snap = await json(`aws ec2 create-snapshot --volume-id ${vol.VolumeId} --description nightly`);
    expect(snap).toMatchObject({ State: "pending", VolumeSize: 20, Description: "nightly" });
    later(5000);
    expect((await json(`aws ec2 describe-snapshots --snapshot-ids ${snap.SnapshotId}`)).Snapshots[0]).toMatchObject({ State: "completed", Progress: "100%" });
    const copy = await json(`aws ec2 copy-snapshot --source-region us-east-1 --source-snapshot-id ${snap.SnapshotId}`, "eu-west-1");
    expect(copy.SnapshotId).toMatch(/^snap-/);

    await json(`aws ec2 detach-volume --volume-id ${vol.VolumeId}`);
    later(2000);
    await json(`aws ec2 delete-volume --volume-id ${vol.VolumeId}`);
    expect(await fails(`aws ec2 describe-volumes --volume-ids ${vol.VolumeId}`)).toMatchObject({ code: "InvalidVolume.NotFound", message: `The volume '${vol.VolumeId}' does not exist.` });
    expect(await fails(`aws ec2 detach-volume --volume-id ${root[0].VolumeId}`)).toMatchObject({ code: "OperationNotPermitted" });
  });
});
