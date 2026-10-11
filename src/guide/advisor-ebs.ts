import type { Engine } from "@/engine/engine";
import { isRootVolume } from "@/engine/services/ebs";
import type { Suggestion } from "./types";

/**
 * Advisor rules for EBS: a data volume with no backup, and volumes left
 * unattached (you pay for them whether or not anything uses them).
 */
export async function storageAdvice(engine: Engine, accountId: string, region: string) {
  const [volumes, snapshots] = await Promise.all([
    engine.list(accountId, { service: "compute", type: "volume", region }),
    engine.list(accountId, { service: "compute", type: "snapshot", region }),
  ]);
  const suggestions: Suggestion[] = [];
  for (const v of volumes) {
    if (isRootVolume(v)) continue;
    const label = v.name || v.id;
    const link = { service: "compute", type: "volume", mode: "detail" as const, id: v.id };
    if (v.state === "available") {
      suggestions.push({
        id: `volume-unattached-${v.id}`,
        level: "intermediate",
        title: `${label} isn't attached to anything`,
        why: "An EBS volume costs money for its size whether or not a server uses it. Forgotten volumes are one of the most common surprises on an AWS bill.",
        steps: [`Attach ${label} to an instance in ${String(v.config.availabilityZone)}, or snapshot it (cheap) and delete it if you only need to keep the data.`],
        link,
        cli: `aws ec2 delete-volume --volume-id ${v.id}`,
      });
    } else if (v.state === "in-use" && ((v.attributes.files as unknown[] | undefined) ?? []).length > 0 && !snapshots.some((s) => s.config.volumeId === v.id)) {
      suggestions.push({
        id: `volume-no-backup-${v.id}`,
        level: "intermediate",
        title: `Back up ${label}`,
        why: "It holds data and has no snapshot. Disks fail and mistakes happen; a snapshot lets you get today's data back.",
        steps: [`Open ${label} and click Create snapshot. (In production, Amazon Data Lifecycle Manager or AWS Backup takes them on a schedule.)`],
        link,
        cli: `aws ec2 create-snapshot --volume-id ${v.id} --description "First backup"`,
      });
    }
  }
  return { suggestions, hasDataVolume: volumes.some((v) => !isRootVolume(v)) };
}
