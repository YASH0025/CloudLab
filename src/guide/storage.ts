import type { Engine } from "@/engine/engine";
import { filesOf, isRootVolume } from "@/engine/services/ebs";
import type { Resource } from "@/engine/types";

export const DATA_FILE = "/data/orders.csv";

/** What the EBS tutorial looks at, around the learner's instance. */
export interface StorageState {
  root?: Resource;
  /** A data volume attached to the instance (preferring the newest one). */
  data?: Resource;
  /** The file's contents on the data volume, if written. */
  file?: string;
  /** A completed snapshot of the data volume that holds the file. */
  snapshot?: Resource;
  snapshotFile?: string;
  /** A volume restored from that snapshot. */
  restored?: Resource;
}

export async function loadStorage(engine: Engine, accountId: string, region: string, instance: Resource | undefined): Promise<StorageState> {
  const [volumes, snapshots] = await Promise.all([
    engine.list(accountId, { service: "compute", type: "volume", region }),
    engine.list(accountId, { service: "compute", type: "snapshot", region }),
  ]);
  const attached = instance ? volumes.filter((v) => v.config.instanceId === instance.id) : [];
  const root = attached.find(isRootVolume);
  const data = attached.filter((v) => !isRootVolume(v)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const fileIn = (r: Resource | undefined) => filesOf(r).find((f) => f.path === DATA_FILE)?.content;
  const snapshot = data
    ? snapshots.filter((s) => s.config.volumeId === data.id && s.state === "completed" && fileIn(s) !== undefined).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    : undefined;
  const restored = snapshot ? volumes.find((v) => v.config.snapshotId === snapshot.id) : undefined;
  return { root, data, file: fileIn(data), snapshot, snapshotFile: fileIn(snapshot), restored };
}
