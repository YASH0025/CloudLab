import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { resolvePrincipal } from "@/engine/iam/authorize";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";

let clock: Date;
let engine: Engine;
const ACCOUNT = "acct-rds-cli";
const ctx = () => ({ engine, accountId: ACCOUNT, region: "us-east-1" });
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

async function json(line: string) {
  const r = await executeCli(line, ctx());
  if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
  return r.output ? JSON.parse(r.output) : {};
}

async function fails(line: string) {
  const r = await executeCli(line, ctx());
  const m = /\(([^)]+)\) when calling the (\w+) operation: (.*)/.exec(r.output);
  if (!m) throw new Error(r.output);
  return { code: m[1], operation: m[2], message: m[3] };
}

/** Two private subnets in two zones of a new VPC, plus app and database security groups. */
async function network() {
  const vpc = (await json("aws ec2 create-vpc --cidr-block 10.0.0.0/16")).Vpc.VpcId;
  advance(2_000);
  const a = (await json(`aws ec2 create-subnet --vpc-id ${vpc} --cidr-block 10.0.11.0/24 --availability-zone us-east-1a`)).Subnet.SubnetId;
  const b = (await json(`aws ec2 create-subnet --vpc-id ${vpc} --cidr-block 10.0.12.0/24 --availability-zone us-east-1b`)).Subnet.SubnetId;
  const app = (await json(`aws ec2 create-security-group --group-name app --description app --vpc-id ${vpc}`)).GroupId;
  const db = (await json(`aws ec2 create-security-group --group-name db --description db --vpc-id ${vpc}`)).GroupId;
  await json(`aws ec2 authorize-security-group-ingress --group-id ${db} --protocol tcp --port 5432 --source-group ${app}`);
  return { vpc, a, b, app, db };
}

const CREATE = (sg: string, extra = "") =>
  `aws rds create-db-instance --db-instance-identifier App-DB --db-instance-class db.t3.micro --engine postgres --master-username app --master-user-password 'Sup3r-secret' --allocated-storage 20 --db-subnet-group-name app-subnets --vpc-security-group-ids ${sg} ${extra}`;

beforeEach(() => {
  clock = new Date("2026-04-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("aws rds", () => {
  it("creates a private database the way RDS does", async () => {
    const n = await network();
    expect(await fails(`aws rds create-db-subnet-group --db-subnet-group-name one --db-subnet-group-description x --subnet-ids ${n.a}`)).toMatchObject({
      code: "DBSubnetGroupDoesNotCoverEnoughAZs",
    });
    const group = (await json(`aws rds create-db-subnet-group --db-subnet-group-name app-subnets --db-subnet-group-description "App DB" --subnet-ids ${n.a} ${n.b}`))
      .DBSubnetGroup;
    expect(group).toMatchObject({ DBSubnetGroupName: "app-subnets", VpcId: n.vpc, SubnetGroupStatus: "Complete" });
    expect(group.Subnets).toHaveLength(2);

    const db = (await json(CREATE(n.db))).DBInstance;
    expect(db).toMatchObject({
      DBInstanceIdentifier: "app-db",
      DBInstanceStatus: "creating",
      Engine: "postgres",
      EngineVersion: "17.2",
      PendingModifiedValues: { MasterUserPassword: "****" },
      PubliclyAccessible: false,
      LicenseModel: "postgresql-license",
      DBParameterGroups: [{ DBParameterGroupName: "default.postgres17", ParameterApplyStatus: "in-sync" }],
    });
    expect(db.Endpoint).toBeUndefined();
    expect(JSON.stringify(db)).not.toContain("Sup3r-secret");

    advance(16_000);
    const live = (await json("aws rds describe-db-instances --db-instance-identifier app-db")).DBInstances[0];
    expect(live.DBInstanceStatus).toBe("available");
    expect(live.Endpoint).toMatchObject({ Port: 5432 });
    expect(live.Endpoint.Address).toMatch(/^app-db\.[0-9a-f]{12}\.us-east-1\.rds\.cloudlab\.local$/);

    expect(await fails("aws rds describe-db-instances --db-instance-identifier ghost")).toMatchObject({
      code: "DBInstanceNotFound",
      message: "DBInstance ghost not found.",
    });
    expect(await fails(CREATE(n.db))).toMatchObject({ code: "DBInstanceAlreadyExists" });
    expect(await fails(CREATE(n.db).replace("'Sup3r-secret'", "short").replace("App-DB", "other"))).toMatchObject({
      message: "The parameter MasterUserPassword is not a valid password because it is shorter than 8 characters.",
    });
  });

  it("defers changes to the maintenance window unless --apply-immediately", async () => {
    const n = await network();
    await json(`aws rds create-db-subnet-group --db-subnet-group-name app-subnets --db-subnet-group-description x --subnet-ids ${n.a} ${n.b}`);
    await json(CREATE(n.db));
    expect(await fails("aws rds modify-db-instance --db-instance-identifier app-db --allocated-storage 30")).toMatchObject({
      code: "InvalidDBInstanceState",
      message: "Database instance is not in available state.",
    });
    advance(16_000);

    let db = (await json("aws rds modify-db-instance --db-instance-identifier app-db --db-instance-class db.t3.small")).DBInstance;
    expect(db).toMatchObject({ DBInstanceClass: "db.t3.micro", DBInstanceStatus: "available", PendingModifiedValues: { DBInstanceClass: "db.t3.small" } });

    db = (await json("aws rds modify-db-instance --db-instance-identifier app-db --multi-az --apply-immediately")).DBInstance;
    expect(db).toMatchObject({ DBInstanceClass: "db.t3.small", MultiAZ: true, DBInstanceStatus: "modifying", PendingModifiedValues: {} });
    expect(db.SecondaryAvailabilityZone).toBe("us-east-1b");
    advance(6_000);

    db = (await json("aws rds reboot-db-instance --db-instance-identifier app-db --force-failover")).DBInstance;
    expect(db).toMatchObject({ DBInstanceStatus: "rebooting", AvailabilityZone: "us-east-1b", SecondaryAvailabilityZone: "us-east-1a" });
    advance(7_000);

    expect(await fails("aws rds start-db-instance --db-instance-identifier app-db")).toMatchObject({
      message: "Instance app-db is not stopped, cannot be started.",
    });
    await json("aws rds stop-db-instance --db-instance-identifier app-db");
    advance(6_000);
    expect((await json("aws rds describe-db-instances")).DBInstances[0].DBInstanceStatus).toBe("stopped");
  });

  it("snapshots, restores and deletes with a final snapshot", async () => {
    const n = await network();
    await json(`aws rds create-db-subnet-group --db-subnet-group-name app-subnets --db-subnet-group-description x --subnet-ids ${n.a} ${n.b}`);
    await json(CREATE(n.db, "--db-name shop"));
    expect(await fails("aws rds create-db-snapshot --db-snapshot-identifier early --db-instance-identifier app-db")).toMatchObject({
      code: "InvalidDBInstanceState",
    });
    advance(16_000);
    const snap = (await json("aws rds create-db-snapshot --db-snapshot-identifier before-migration --db-instance-identifier app-db")).DBSnapshot;
    expect(snap).toMatchObject({ DBSnapshotIdentifier: "before-migration", Status: "creating", PercentProgress: 0, Engine: "postgres" });
    expect(await fails("aws rds restore-db-instance-from-db-snapshot --db-instance-identifier copy --db-snapshot-identifier before-migration")).toMatchObject({
      code: "InvalidDBSnapshotState",
    });
    advance(6_000);

    const copy = (await json("aws rds restore-db-instance-from-db-snapshot --db-instance-identifier copy --db-snapshot-identifier before-migration")).DBInstance;
    // A restored database gets the VPC's default security group, a classic surprise.
    const defaultSg = (await json(`aws ec2 describe-security-groups --filters Name=vpc-id,Values=${n.vpc} Name=group-name,Values=default`)).SecurityGroups[0].GroupId;
    expect(copy).toMatchObject({ DBInstanceIdentifier: "copy", DBName: "shop", MasterUsername: "app", VpcSecurityGroups: [{ VpcSecurityGroupId: defaultSg, Status: "active" }] });

    expect(await fails("aws rds delete-db-instance --db-instance-identifier app-db")).toMatchObject({
      code: "InvalidParameterCombination",
      message: "FinalDBSnapshotIdentifier is required unless SkipFinalSnapshot is specified.",
    });
    const gone = (await json("aws rds delete-db-instance --db-instance-identifier app-db --final-db-snapshot-identifier app-db-final")).DBInstance;
    expect(gone.DBInstanceStatus).toBe("deleting");
    const snaps = (await json("aws rds describe-db-snapshots --db-instance-identifier app-db")).DBSnapshots.map((s: { DBSnapshotIdentifier: string }) => s.DBSnapshotIdentifier);
    expect(snaps.sort()).toEqual(["app-db-final", "before-migration"]);

    expect(await fails("aws rds delete-db-subnet-group --db-subnet-group-name app-subnets")).toMatchObject({ code: "InvalidDBSubnetGroupStateFault" });
  });

  it("uses the default VPC when no subnet group is given, publicly accessible like RDS", async () => {
    const db = (
      await json("aws rds create-db-instance --db-instance-identifier quick --db-instance-class db.t3.micro --engine mysql --master-username admin --master-user-password 'Passw0rd!' --allocated-storage 20")
    ).DBInstance;
    expect(db).toMatchObject({ Engine: "mysql", EngineVersion: "8.4.3", PubliclyAccessible: true, BackupRetentionPeriod: 1, DBSubnetGroup: { DBSubnetGroupName: "default" } });
    expect((await json("aws rds describe-db-engine-versions --engine mariadb")).DBEngineVersions.map((v: { EngineVersion: string }) => v.EngineVersion)).toEqual([
      "11.4.4",
      "10.11.10",
    ]);
  });

  it("checks rds: permissions against the database's ARN", async () => {
    await json("aws iam create-user --user-name viewer");
    await json("aws iam attach-user-policy --user-name viewer --policy-arn arn:aws:iam::aws:policy/AmazonRDSReadOnlyAccess");
    const asViewer = { ...ctx(), principal: await resolvePrincipal(engine, ACCOUNT, { kind: "user", name: "viewer" }) };
    expect((await executeCli("aws rds describe-db-instances", asViewer)).exitCode).toBe(0);
    const denied = await executeCli("aws rds delete-db-instance --db-instance-identifier prod --skip-final-snapshot", asViewer);
    expect(denied.output).toMatch(/AccessDenied.*rds:DeleteDBInstance on resource: arn:aws:rds:us-east-1:\d{12}:db:prod/);
  });
});
