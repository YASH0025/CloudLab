import type { Engine } from "@/engine/engine";
import type { Resource } from "@/engine/types";
import { coversPort, inboundRules } from "./snapshot";
import type { Suggestion } from "./types";

/**
 * Advisor rules for RDS: a database open to the internet comes first, then a
 * database nothing can connect to (often after a restore, which uses the
 * default security group), then databases without automated backups.
 */
export async function databaseAdvice(engine: Engine, accountId: string, region: string) {
  const dbs = await engine.list(accountId, { service: "rds", type: "db-instance", region });
  const problems: Suggestion[] = [];
  const suggestions: Suggestion[] = [];

  for (const db of dbs) {
    const port = Number(db.attributes.port);
    const groups = (
      await Promise.all(((db.config.vpcSecurityGroupIds as string[]) ?? []).map((id) => engine.get(accountId, id).catch(() => null)))
    ).filter((g): g is Resource => !!g);
    const rules = groups.flatMap((g) => inboundRules(g).filter((r) => coversPort(r, port)).map((r) => ({ g, r })));
    const link = { service: "rds", type: "db-instance", mode: "detail" as const, id: db.id };

    const open = rules.find(({ r }) => r.cidr === "0.0.0.0/0");
    if (db.config.publiclyAccessible && open) {
      problems.push({
        id: `db-open-${db.id}`,
        level: "intermediate",
        title: `${db.name} is open to the whole internet`,
        why: `It's publicly accessible and ${open.g.name || open.g.id} allows port ${port} from 0.0.0.0/0. Anyone can try passwords against it; this is how many real data breaches start.`,
        steps: [
          `Open ${db.name}, untick Publicly accessible and save.`,
          `In ${open.g.name || open.g.id}, replace the 0.0.0.0/0 rule with one whose source is your app servers' security group.`,
          "Connect from your app servers (or through a bastion host) instead.",
        ],
        link,
      });
      continue;
    }

    if (db.state === "available" && rules.length === 0) {
      problems.push({
        id: `db-closed-${db.id}`,
        level: "intermediate",
        title: `Nothing can connect to ${db.name}`,
        why: `None of its security groups allows port ${port}. ${db.attributes.restoredFrom ? "A restored database gets the VPC's default security group unless you choose others, so this is common right after a restore." : "Every connection is refused until a rule allows it."}`,
        steps: [`Open ${db.name} and set its security groups to one that allows TCP ${port} from your app servers' security group.`],
        link,
      });
    }

    if (Number(db.config.backupRetentionPeriod) === 0) {
      suggestions.push({
        id: `db-backups-${db.id}`,
        level: "intermediate",
        title: `Turn on automated backups for ${db.name}`,
        why: "Backup retention is 0, so RDS keeps no daily backups and you can't restore to an earlier time. One bad DELETE and the data is gone.",
        steps: [`Open ${db.name}, set Backup retention to 7 days and save.`],
        link,
        cli: `aws rds modify-db-instance --db-instance-identifier ${db.name} --backup-retention-period 7 --apply-immediately`,
      });
    }
  }
  return { problems, suggestions, hasDatabase: dbs.length > 0 };
}
