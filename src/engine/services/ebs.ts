import { EngineError } from "../errors";
import { ec2Arn } from "../iam/arns";
import { systemOf, type Resource, type ResourceTypeDef, type SystemApi } from "../types";

/**
 * Amazon EBS: disks for EC2 instances. A volume lives in one Availability Zone
 * and attaches to an instance in that zone. Every instance boots from a root
 * volume that's deleted when the instance terminates; extra (data) volumes
 * survive termination. Snapshots are point-in-time backups of a volume: they
 * aren't tied to a zone, so a volume restored from one can go to any zone in
 * the region, and copy-snapshot takes them to other regions.
 *
 * CloudLab volumes hold a few small files (written "from the server" while the
 * volume is attached to a running instance), so backups and restores show
 * real data.
 */

export interface VolumeFile {
  path: string;
  content: string;
  modifiedAt: string;
}

export const VOLUME_TYPES: Record<string, { label: string; min: number; max: number; hint: string }> = {
  gp3: { label: "General Purpose SSD (gp3)", min: 1, max: 16384, hint: "The default: 3,000 IOPS included, whatever the size" },
  gp2: { label: "General Purpose SSD (gp2)", min: 1, max: 16384, hint: "Older: speed grows with size (3 IOPS per GiB)" },
  io2: { label: "Provisioned IOPS SSD (io2)", min: 4, max: 16384, hint: "For busy databases: you choose (and pay for) the IOPS" },
  st1: { label: "Throughput Optimized HDD (st1)", min: 125, max: 16384, hint: "Big, sequential data (logs, data lakes). Can't be a boot disk" },
  sc1: { label: "Cold HDD (sc1)", min: 125, max: 16384, hint: "Cheapest, for data you rarely read. Can't be a boot disk" },
};

export const ROOT_DEVICE = "/dev/xvda";
const DATA_DEVICE = /^\/dev\/(sd[b-z]|xvd[b-z])$/;
export const MAX_FILES = 25;
export const MAX_FILE_BYTES = 10_000;

export const filesOf = (r: Resource | null | undefined) => ((r?.attributes.files as VolumeFile[] | undefined) ?? []).slice();
export const isRootVolume = (v: Resource) => !!systemOf(v).ownedBy && v.config.device === ROOT_DEVICE;

/** Attachment and detachment are platform transitions (attaching → in-use, detaching → available). */
async function syncAttachment(system: SystemApi, volume: Resource) {
  const wants = !!volume.config.instanceId;
  if (wants && volume.state === "available") await system.runAction(volume.id, "attach");
  if (!wants && (volume.state === "in-use" || volume.state === "attaching")) await system.runAction(volume.id, "detach");
}

export const volume: ResourceTypeDef = {
  service: "compute",
  type: "volume",
  label: "Volume",
  pluralLabel: "Volumes",
  description:
    "A disk (EBS volume) for an instance, in one Availability Zone. Data on it survives stopping, and a data volume even survives terminating the instance. Back it up with snapshots.",
  idPrefix: "vol",
  notFoundCode: "InvalidVolume.NotFound",
  notFoundMessage: (id) => `The volume '${id}' does not exist.`,
  apiNoun: "volume",
  stateErrorCode: "IncorrectState",
  panelAttributes: ["files", "terminating"],
  iam: {
    create: "ec2:CreateVolume",
    read: "ec2:DescribeVolumes",
    update: (changed) => [
      ...(changed.includes("instanceId") ? ["ec2:AttachVolume", "ec2:DetachVolume"] : []),
      ...(changed.some((c) => ["size", "volumeType", "iops"].includes(c)) ? ["ec2:ModifyVolume"] : []),
      ...(changed.includes("name") ? ["ec2:CreateTags"] : []),
    ],
    delete: "ec2:DeleteVolume",
    arn: ec2Arn("volume"),
  },
  fields: [
    { key: "name", label: "Name", type: "string", maxLength: 255, placeholder: "app-data" },
    {
      key: "availabilityZone",
      label: "Availability Zone",
      type: "enum",
      required: true,
      immutable: true,
      optionsSource: "availabilityZones",
      param: "AvailabilityZone",
      description: "A volume can only attach to instances in the same zone. To move it, snapshot it and restore the snapshot in the other zone.",
    },
    {
      key: "snapshotId",
      label: "Restore from snapshot",
      type: "ref",
      immutable: true,
      ref: { service: "compute", type: "snapshot", weak: true },
      param: "SnapshotId",
      description: "Optional: start with a snapshot's data (from any zone in this region).",
    },
    {
      key: "size",
      label: "Size (GiB)",
      type: "number",
      min: 1,
      max: 16384,
      param: "Size",
      placeholder: "10",
      description: "Can grow later, never shrink. Restoring a snapshot? Leave empty for the snapshot's size.",
    },
    {
      key: "volumeType",
      label: "Volume type",
      type: "enum",
      required: true,
      default: "gp3",
      param: "VolumeType",
      options: Object.entries(VOLUME_TYPES).map(([value, t]) => ({ value, label: t.label, hint: t.hint })),
    },
    {
      key: "iops",
      label: "IOPS",
      type: "number",
      min: 100,
      max: 64000,
      param: "Iops",
      description: "Reads and writes per second. gp3: 3,000 to 16,000 (3,000 free). io2: required.",
      showWhen: { field: "volumeType", in: ["gp3", "io2"] },
    },
    { key: "encrypted", label: "Encrypted", type: "boolean", default: false, immutable: true, param: "Encrypted", description: "Encrypts data at rest with a KMS key. Volumes restored from an encrypted snapshot are always encrypted." },
    {
      key: "instanceId",
      label: "Attached to instance",
      type: "ref",
      ref: { service: "compute", type: "instance", weak: true },
      param: "InstanceId",
      description: "Attach to a running or stopped instance in the same zone. Clear it to detach.",
    },
    {
      key: "device",
      label: "Device name",
      type: "string",
      default: "/dev/sdf",
      maxLength: 32,
      param: "Device",
      description: "How the instance sees the disk, e.g. /dev/sdf (Linux shows it as /dev/nvme1n1 or /dev/xvdf). Used when attached.",
    },
  ],
  columns: [
    { label: "Size", path: "attributes.sizeLabel" },
    { label: "Type", path: "config.volumeType" },
    { label: "AZ", path: "config.availabilityZone" },
    { label: "Attached to", path: "config.instanceId", mono: true },
  ],
  lifecycle: {
    create: { state: "creating", settlesTo: "available", afterMs: 2000 },
    actions: {
      attach: { label: "Attach", from: ["available"], via: "attaching", to: "in-use", afterMs: 1500, pastTense: "attached", hidden: true },
      detach: { label: "Detach", from: ["in-use", "attaching"], via: "detaching", to: "available", afterMs: 1500, pastTense: "detached", hidden: true },
    },
    deletableStates: ["available", "creating", "error", "in-use", "attaching", "detaching"],
  },
  canDelete: (v) => {
    if ((v.state === "in-use" || v.state === "attaching" || v.state === "detaching") && !v.attributes.terminating) {
      return new EngineError("VolumeInUse", `Volume ${v.id} is currently attached to ${String(v.config.instanceId ?? "an instance")}`);
    }
    return undefined;
  },
  invalidValue({ field, value }) {
    if (field.key === "volumeType") return new EngineError("InvalidParameterValue", `Value (${String(value)}) for parameter volumeType is invalid. Allowed: ${Object.keys(VOLUME_TYPES).join(", ")}.`);
    if (field.key === "size") return new EngineError("InvalidParameterValue", `The volume size is invalid: ${String(value)}. It must be between 1 and 16384 GiB.`);
    return undefined;
  },
  async normalize({ config, ctx }) {
    const c = { ...config };
    if (c.snapshotId) {
      const snap = await ctx.get(String(c.snapshotId));
      if (snap) {
        if (c.size === undefined || c.size === null) c.size = Number(snap.attributes.volumeSize);
        if (snap.attributes.encrypted) c.encrypted = true;
      }
    }
    if (c.volumeType === "gp3" && (c.iops === undefined || c.iops === null)) c.iops = 3000;
    if (c.volumeType !== "gp3" && c.volumeType !== "io2") c.iops = undefined;
    if (!c.instanceId) {
      c.instanceId = undefined;
      c.device = undefined;
    } else if (!c.device) c.device = "/dev/sdf";
    return c;
  },
  async validate({ config, existing, ctx }) {
    const type = String(config.volumeType);
    const t = VOLUME_TYPES[type];
    const size = config.size as number | undefined;
    if (size === undefined || size === null) throw new EngineError("MissingParameter", "The request must contain the parameter size or snapshotId");
    if (size < t.min || size > t.max) throw new EngineError("InvalidParameterValue", `The volume size is invalid for ${type} volumes: ${t.min} through ${t.max}.`);
    if (type === "io2" && !config.iops) throw new EngineError("InvalidParameterCombination", "The parameter iops must be specified for io2 volumes.");
    if (type === "gp3" && config.iops && (Number(config.iops) < 3000 || Number(config.iops) > 16000)) {
      throw new EngineError("InvalidParameterValue", `Iops ${String(config.iops)} is invalid for gp3 volumes: 3000 through 16000.`);
    }
    if (config.snapshotId && !existing) {
      const snap = await ctx.get(String(config.snapshotId));
      const min = Number(snap?.attributes.volumeSize ?? 0);
      if (size < min) throw new EngineError("InvalidParameterValue", `Volume of size ${size} GiB is smaller than snapshot '${String(config.snapshotId)}', expect size >= ${min} GiB`);
    }
    if (existing) {
      if (size < Number(existing.config.size)) throw new EngineError("InvalidParameterValue", "New size cannot be smaller than existing size");
    }

    const before = existing?.config.instanceId as string | undefined;
    const after = config.instanceId as string | undefined;
    const id = existing?.id ?? "";
    if (before && after && before !== after) throw new EngineError("VolumeInUse", `${id} is already attached to an instance`);
    if (before && !after && existing && isRootVolume(existing) && !existing.attributes.terminating) {
      throw new EngineError("OperationNotPermitted", `Unable to detach root volume '${id}' from instance '${before}'`);
    }
    if (after && !before) {
      if (existing && !["available", "creating"].includes(existing.state ?? "")) throw new EngineError("IncorrectState", `${id} is in the '${existing.state}' state.`);
      const inst = await ctx.get(after);
      if (!inst) return; // reported by the reference check
      if (!["running", "stopped", "pending"].includes(inst.state ?? "")) throw new EngineError("IncorrectState", `Instance '${after}' is not 'running' or 'stopped'.`);
      if (inst.attributes.availabilityZone !== config.availabilityZone) {
        throw new EngineError("InvalidVolume.ZoneMismatch", `The volume '${id}' is not in the same availability zone as instance '${after}'`);
      }
      const device = String(config.device);
      if (device !== ROOT_DEVICE && !DATA_DEVICE.test(device)) {
        throw new EngineError("InvalidParameterValue", `Value (${device}) for parameter device is invalid. ${device} is not a valid EBS device name.`);
      }
      const taken = (await ctx.list("compute", "volume")).some((v) => v.id !== id && v.config.instanceId === after && v.config.device === device);
      if (taken) throw new EngineError("InvalidParameterValue", `Invalid value '${device}' for unixDevice. Attachment point ${device} is already in use`);
    }
  },
  async derive({ config, existing, ctx }) {
    let files = filesOf(existing);
    if (!existing && config.snapshotId) files = filesOf(await ctx.get(String(config.snapshotId)));
    return {
      ...(existing?.attributes ?? {}),
      sizeLabel: `${String(config.size)} GiB`,
      files,
      ...(existing ? {} : { createdFromSnapshot: config.snapshotId ?? null }),
    };
  },
  async afterCreate({ resource, system }) {
    await syncAttachment(system, resource);
  },
  async afterUpdate({ resource, system }) {
    await syncAttachment(system, resource);
  },
  /** A volume created already attached (a root volume) attaches as soon as it's ready. */
  async onSettled({ resource, system }) {
    if (resource.state === "available") await syncAttachment(system, resource);
  },
};

export const snapshot: ResourceTypeDef = {
  service: "compute",
  type: "snapshot",
  label: "Snapshot",
  pluralLabel: "Snapshots",
  description:
    "A point-in-time backup of a volume, stored in S3 by AWS. Restore it as a new volume in any zone of the region, or copy it to another region for disaster recovery.",
  idPrefix: "snap",
  notFoundCode: "InvalidSnapshot.NotFound",
  notFoundMessage: (id) => `The snapshot '${id}' does not exist.`,
  apiNoun: "snapshot",
  stateErrorCode: "IncorrectState",
  panelAttributes: ["files"],
  iam: {
    create: "ec2:CreateSnapshot",
    read: "ec2:DescribeSnapshots",
    update: "ec2:CreateTags",
    delete: "ec2:DeleteSnapshot",
    arn: (r) => `arn:aws:ec2:${r.region}::snapshot/${r.id}`,
  },
  fields: [
    { key: "name", label: "Name", type: "string", maxLength: 255, placeholder: "app-data-before-upgrade" },
    {
      key: "volumeId",
      label: "Volume",
      type: "ref",
      immutable: true,
      ref: { service: "compute", type: "volume", weak: true },
      param: "VolumeId",
      description: "The volume to back up. It can stay attached and in use; the snapshot captures it as it is right now.",
    },
    { key: "description", label: "Description", type: "string", maxLength: 255, immutable: true, param: "Description" },
    {
      key: "sourceSnapshotId",
      label: "Copy of snapshot",
      type: "string",
      immutable: true,
      maxLength: 64,
      param: "SourceSnapshotId",
      description: "Set by copy-snapshot (a copy from another region).",
      // Never shown in the console form (an empty list means "no value shows it"); the console copies with its own button.
      showWhen: { field: "sourceSnapshotId", in: [] },
    },
    { key: "sourceRegion", label: "Source region", type: "string", immutable: true, maxLength: 32, param: "SourceRegion", showWhen: { field: "sourceSnapshotId", in: [] } },
  ],
  columns: [
    { label: "Volume", path: "attributes.volumeIdShown", mono: true },
    { label: "Size", path: "attributes.sizeLabel" },
    { label: "Description", path: "config.description" },
  ],
  lifecycle: { create: { state: "pending", settlesTo: "completed", afterMs: 4000 } },
  async validate({ config, ctx }) {
    if (!config.volumeId && !config.sourceSnapshotId) throw new EngineError("MissingParameter", "The request must contain the parameter volumeId");
    if (config.sourceSnapshotId) {
      const source = await ctx.get(String(config.sourceSnapshotId));
      if (!source || source.type !== "snapshot" || (config.sourceRegion && source.region !== config.sourceRegion)) {
        throw new EngineError("InvalidSnapshot.NotFound", `The snapshot '${String(config.sourceSnapshotId)}' does not exist.`);
      }
      if (source.state !== "completed") throw new EngineError("IncorrectState", `Snapshot '${source.id}' is not in the 'completed' state.`);
    }
  },
  async derive({ config, existing, ctx }) {
    if (existing) return existing.attributes;
    if (config.sourceSnapshotId) {
      const source = await ctx.get(String(config.sourceSnapshotId));
      return {
        volumeIdShown: "vol-ffffffff",
        volumeSize: source?.attributes.volumeSize,
        sizeLabel: `${String(source?.attributes.volumeSize)} GiB`,
        encrypted: source?.attributes.encrypted ?? false,
        files: filesOf(source),
        copiedFrom: `${String(source?.region)}/${String(config.sourceSnapshotId)}`,
      };
    }
    const vol = await ctx.get(String(config.volumeId));
    return {
      volumeIdShown: config.volumeId,
      volumeSize: vol?.config.size,
      sizeLabel: `${String(vol?.config.size)} GiB`,
      encrypted: vol?.config.encrypted ?? false,
      // What was on the disk at this moment; later writes don't change the snapshot.
      files: filesOf(vol),
    };
  },
};

/** "Writes a file from the server": only while the volume is attached to a running instance. */
export async function writeVolumeFile(
  get: (id: string) => Promise<Resource>,
  setAttributes: (id: string, patch: Record<string, unknown>) => Promise<void>,
  volumeId: string,
  input: { path: string; content: string },
  now: Date,
): Promise<VolumeFile[]> {
  const vol = await get(volumeId);
  if (vol.state !== "in-use" || !vol.config.instanceId) {
    throw new EngineError("IncorrectState", "The volume isn't attached to an instance. Files are written by software on a server: attach the volume to a running instance first.");
  }
  const inst = await get(String(vol.config.instanceId));
  if (inst.state !== "running") throw new EngineError("IncorrectInstanceState", `The instance ${inst.id} is ${inst.state ?? "not running"}. Start it to write to its disks.`);
  const path = input.path.trim();
  if (!/^\/[\w./-]{1,200}$/.test(path) || path.includes("..")) throw new EngineError("InvalidParameterValue", "Use an absolute path like /data/orders.csv (letters, digits, - _ . and /).");
  if (Buffer.byteLength(input.content) > MAX_FILE_BYTES) throw new EngineError("InvalidParameterValue", `Keep files under ${MAX_FILE_BYTES / 1000} KB in CloudLab.`);
  const files = filesOf(vol).filter((f) => f.path !== path);
  if (files.length >= MAX_FILES) throw new EngineError("InvalidParameterValue", `A CloudLab volume holds up to ${MAX_FILES} files.`);
  files.push({ path, content: input.content, modifiedAt: now.toISOString() });
  files.sort((a, b) => a.path.localeCompare(b.path));
  await setAttributes(vol.id, { files });
  return files;
}

/** The root volume every instance boots from (8 GiB gp3, deleted on termination). */
export async function createRootVolume(system: SystemApi, instance: Resource) {
  const root = await system.create(
    "compute",
    "volume",
    {
      name: "",
      availabilityZone: instance.attributes.availabilityZone,
      size: 8,
      volumeType: "gp3",
      encrypted: false,
      instanceId: instance.id,
      device: ROOT_DEVICE,
    },
    { ownedBy: instance.id },
  );
  await system.setAttributes(root.id, {
    files: [{ path: "/etc/os-release", content: 'NAME="Amazon Linux"\nVERSION="2023"\nID="amzn"\nPRETTY_NAME="Amazon Linux 2023 (CloudLab)"\n', modifiedAt: root.createdAt }],
  });
}

/** When an instance terminates: its root volume is deleted, data volumes are detached and kept. */
export async function releaseVolumes(system: SystemApi, instanceId: string) {
  for (const v of await system.list("compute", "volume")) {
    if (v.config.instanceId !== instanceId) continue;
    if (isRootVolume(v)) {
      await system.setAttributes(v.id, { terminating: true });
      await system.remove(v.id);
    } else {
      await system.update(v.id, { instanceId: null });
    }
  }
}
