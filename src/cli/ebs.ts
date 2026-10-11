import { EngineError } from "@/engine/errors";
import { accountNumber } from "@/engine/ids";
import { isRootVolume } from "@/engine/services/ebs";
import type { Resource } from "@/engine/types";
import type { Args, CliContext, Command } from "./commands";
import { parseShorthand } from "./parse";
import { tags } from "./present";

/**
 * EBS commands of `aws ec2`: volumes (create, attach, detach, modify, delete)
 * and snapshots (create, copy to another region, delete).
 */

const cmd = (c: Command) => c;

const load = (ctx: CliContext, type: string, id: string, region = ctx.region) => ctx.engine.getTyped(ctx.accountId, id, "compute", type, region);
const listOf = (ctx: CliContext, type: string) => ctx.engine.list(ctx.accountId, { service: "compute", type, region: ctx.region });

/** --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=x}]' → the Name tag. */
function nameTag(args: Args): string | undefined {
  const all = args.raw("tag-specifications").join(" ");
  const m = /"?Key"?\s*[:=]\s*"?Name"?\s*,\s*"?Value"?\s*[:=]\s*"?([^"}\],]+)/.exec(all);
  return m?.[1]?.trim();
}

/** --filters Name=x,Values=a,b for the few filters people use with volumes and snapshots. */
function filtered(args: Args, items: Resource[]): Resource[] {
  return args.raw("filters").reduce((acc, raw) => {
    const f = parseShorthand(raw);
    const name = String(f.Name ?? "");
    const values = ([] as string[]).concat(f.Values ?? []);
    const pick = (r: Resource): unknown => {
      if (name === "attachment.instance-id") return r.config.instanceId;
      if (name === "status") return r.state;
      if (name === "availability-zone") return r.config.availabilityZone;
      if (name === "volume-id") return r.type === "snapshot" ? r.attributes.volumeIdShown : r.id;
      if (name === "volume-type") return r.config.volumeType;
      if (name === "tag:Name") return r.name;
      return undefined;
    };
    return acc.filter((r) => values.includes(String(pick(r))));
  }, items);
}

function attachmentOut(v: Resource, state = v.state === "attaching" ? "attaching" : v.state === "detaching" ? "detaching" : "attached") {
  return {
    AttachTime: v.updatedAt,
    Device: v.config.device,
    InstanceId: v.config.instanceId,
    State: state,
    VolumeId: v.id,
    DeleteOnTermination: isRootVolume(v),
  };
}

function volumeOut(v: Resource) {
  const t = tags(v);
  return {
    Attachments: v.config.instanceId ? [attachmentOut(v)] : [],
    AvailabilityZone: v.config.availabilityZone,
    CreateTime: v.createdAt,
    Encrypted: v.config.encrypted === true,
    Size: v.config.size,
    SnapshotId: (v.config.snapshotId as string | undefined) ?? "",
    State: v.state,
    VolumeId: v.id,
    ...(v.config.iops ? { Iops: v.config.iops } : {}),
    ...(t ? { Tags: t } : {}),
    VolumeType: v.config.volumeType,
    ...(v.config.volumeType === "gp3" ? { Throughput: 125 } : {}),
    MultiAttachEnabled: false,
  };
}

function snapshotOut(s: Resource, ctx: CliContext) {
  const t = tags(s);
  return {
    Description: (s.config.description as string | undefined) ?? "",
    Encrypted: s.attributes.encrypted === true,
    OwnerId: accountNumber(ctx.accountId),
    Progress: s.state === "completed" ? "100%" : "",
    SnapshotId: s.id,
    StartTime: s.createdAt,
    State: s.state,
    VolumeId: s.attributes.volumeIdShown,
    VolumeSize: s.attributes.volumeSize,
    ...(t ? { Tags: t } : {}),
    StorageTier: "standard",
  };
}

const intArg = (args: Args, name: string) => {
  const v = args.one(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new EngineError("InvalidParameterValue", `Invalid value for parameter ${name}: ${v}`);
  return n;
};

export const EBS_COMMANDS: Command[] = [
  // --- volumes ---
  cmd({
    service: "ec2",
    operation: "create-volume",
    apiName: "CreateVolume",
    summary: "Create an EBS volume (a disk) in one Availability Zone",
    usage: "--availability-zone <az> [--size <GiB>] [--volume-type gp3|gp2|io2|st1|sc1] [--iops <n>] [--snapshot-id <snap-id>] [--encrypted] [--tag-specifications <spec>]",
    mutates: true,
    async run(args, ctx) {
      const v = await ctx.engine.create(ctx.accountId, {
        service: "compute",
        type: "volume",
        region: ctx.region,
        config: {
          name: nameTag(args),
          availabilityZone: args.required("availability-zone"),
          size: intArg(args, "size"),
          volumeType: args.one("volume-type") ?? "gp2",
          iops: intArg(args, "iops"),
          snapshotId: args.one("snapshot-id"),
          encrypted: args.bool("encrypted") ?? false,
        },
      });
      return volumeOut(v);
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-volumes",
    apiName: "DescribeVolumes",
    summary: "List volumes and what they're attached to",
    usage: "[--volume-ids <id> ...] [--filters Name=attachment.instance-id,Values=<id>]",
    mutates: false,
    async run(args, ctx) {
      const ids = args.list("volume-ids");
      const items = ids.length ? await Promise.all(ids.map((id) => load(ctx, "volume", id))) : await listOf(ctx, "volume");
      return { Volumes: filtered(args, items).map(volumeOut) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "attach-volume",
    apiName: "AttachVolume",
    summary: "Attach a volume to an instance in the same zone",
    usage: "--volume-id <id> --instance-id <id> --device <name, e.g. /dev/sdf>",
    mutates: true,
    async run(args, ctx) {
      const v = await load(ctx, "volume", args.required("volume-id"));
      const instanceId = args.required("instance-id");
      await load(ctx, "instance", instanceId);
      if (v.config.instanceId) throw new EngineError("VolumeInUse", `${v.id} is already attached to an instance`);
      if (v.state !== "available") throw new EngineError("IncorrectState", `${v.id} is in the '${v.state}' state.`);
      const updated = await ctx.engine.update(ctx.accountId, v.id, { instanceId, device: args.required("device") });
      return attachmentOut(updated, "attaching");
    },
  }),
  cmd({
    service: "ec2",
    operation: "detach-volume",
    apiName: "DetachVolume",
    summary: "Detach a volume from its instance (unmount it on the server first)",
    usage: "--volume-id <id> [--instance-id <id>] [--force]",
    mutates: true,
    async run(args, ctx) {
      const v = await load(ctx, "volume", args.required("volume-id"));
      if (!v.config.instanceId) throw new EngineError("IncorrectState", `Volume '${v.id}' is in the '${v.state}' state.`);
      const given = args.one("instance-id");
      if (given && given !== v.config.instanceId) throw new EngineError("InvalidAttachment.NotFound", `The volume ${v.id} is not attached to instance ${given}`);
      const before = attachmentOut(v, "detaching");
      await ctx.engine.update(ctx.accountId, v.id, { instanceId: null });
      return before;
    },
  }),
  cmd({
    service: "ec2",
    operation: "modify-volume",
    apiName: "ModifyVolume",
    summary: "Grow a volume or change its type, even while it's in use",
    usage: "--volume-id <id> [--size <GiB>] [--volume-type <type>] [--iops <n>]",
    mutates: true,
    async run(args, ctx) {
      const v = await load(ctx, "volume", args.required("volume-id"));
      const patch: Record<string, unknown> = {};
      const size = intArg(args, "size");
      if (size !== undefined) patch.size = size;
      if (args.one("volume-type")) patch.volumeType = args.one("volume-type");
      const iops = intArg(args, "iops");
      if (iops !== undefined) patch.iops = iops;
      if (Object.keys(patch).length === 0) throw new EngineError("MissingParameter", "The request must contain at least one of size, volumeType or iops");
      const updated = await ctx.engine.update(ctx.accountId, v.id, patch);
      return {
        VolumeModification: {
          VolumeId: v.id,
          ModificationState: "modifying",
          TargetSize: updated.config.size,
          TargetVolumeType: updated.config.volumeType,
          OriginalSize: v.config.size,
          OriginalVolumeType: v.config.volumeType,
          Progress: 0,
          StartTime: ctx.engine.now().toISOString(),
        },
      };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-volume",
    apiName: "DeleteVolume",
    summary: "Delete a volume (it must be detached)",
    usage: "--volume-id <id>",
    mutates: true,
    async run(args, ctx) {
      const v = await load(ctx, "volume", args.required("volume-id"));
      await ctx.engine.remove(ctx.accountId, v.id);
    },
  }),

  // --- snapshots ---
  cmd({
    service: "ec2",
    operation: "create-snapshot",
    apiName: "CreateSnapshot",
    summary: "Back up a volume as it is right now",
    usage: "--volume-id <id> [--description <text>] [--tag-specifications <spec>]",
    mutates: true,
    async run(args, ctx) {
      const volumeId = args.required("volume-id");
      await load(ctx, "volume", volumeId);
      const s = await ctx.engine.create(ctx.accountId, {
        service: "compute",
        type: "snapshot",
        region: ctx.region,
        config: { name: nameTag(args), volumeId, description: args.one("description") },
      });
      return snapshotOut(s, ctx);
    },
  }),
  cmd({
    service: "ec2",
    operation: "describe-snapshots",
    apiName: "DescribeSnapshots",
    summary: "List your snapshots",
    usage: "[--snapshot-ids <id> ...] [--owner-ids self] [--filters Name=volume-id,Values=<id>]",
    mutates: false,
    async run(args, ctx) {
      const ids = args.list("snapshot-ids");
      const items = ids.length ? await Promise.all(ids.map((id) => load(ctx, "snapshot", id))) : await listOf(ctx, "snapshot");
      return { Snapshots: filtered(args, items).map((s) => snapshotOut(s, ctx)) };
    },
  }),
  cmd({
    service: "ec2",
    operation: "copy-snapshot",
    apiName: "CopySnapshot",
    summary: "Copy a snapshot from another region into this one (disaster recovery)",
    usage: "--source-region <region> --source-snapshot-id <id> [--description <text>]",
    mutates: true,
    async run(args, ctx) {
      const sourceRegion = args.required("source-region");
      const sourceId = args.required("source-snapshot-id");
      await load(ctx, "snapshot", sourceId, sourceRegion);
      const s = await ctx.engine.create(ctx.accountId, {
        service: "compute",
        type: "snapshot",
        region: ctx.region,
        config: { sourceSnapshotId: sourceId, sourceRegion, description: args.one("description") ?? `[Copied ${sourceId} from ${sourceRegion}]` },
      });
      return { SnapshotId: s.id };
    },
  }),
  cmd({
    service: "ec2",
    operation: "delete-snapshot",
    apiName: "DeleteSnapshot",
    summary: "Delete a snapshot",
    usage: "--snapshot-id <id>",
    mutates: true,
    async run(args, ctx) {
      const s = await load(ctx, "snapshot", args.required("snapshot-id"));
      await ctx.engine.remove(ctx.accountId, s.id);
    },
  }),
];
