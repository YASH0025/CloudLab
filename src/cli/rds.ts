import { EngineError } from "@/engine/errors";
import { DB_ENGINES, defaultSecurityGroupFor, ensureDefaultSubnetGroup } from "@/engine/services/rds";
import type { Resource } from "@/engine/types";
import type { Args, CliContext, Command } from "./commands";
import { UsageError } from "./parse";

/**
 * `aws rds`: subnet groups, DB instances and snapshots, addressed by
 * identifier, with RDS's output shapes and errors. Modifications wait for the
 * maintenance window unless --apply-immediately is given, as in RDS.
 */

const cmd = (c: Command) => c;

const list = (ctx: CliContext, type: string) => ctx.engine.list(ctx.accountId, { service: "rds", type, region: ctx.region });
const create = (ctx: CliContext, type: string, config: Record<string, unknown>) =>
  ctx.engine.create(ctx.accountId, { service: "rds", type, region: ctx.region, config });

async function dbByName(ctx: CliContext, name: string): Promise<Resource> {
  const db = (await list(ctx, "db-instance")).find((d) => d.name === name.toLowerCase());
  if (!db) throw new EngineError("DBInstanceNotFound", `DBInstance ${name} not found.`, 404);
  return db;
}

async function groupByName(ctx: CliContext, name: string): Promise<Resource> {
  const g = (await list(ctx, "db-subnet-group")).find((x) => x.name === name);
  if (!g) throw new EngineError("DBSubnetGroupNotFoundFault", `DBSubnetGroup '${name}' not found.`, 404);
  return g;
}

async function snapshotByName(ctx: CliContext, name: string): Promise<Resource> {
  const s = (await list(ctx, "db-snapshot")).find((x) => x.name === name.toLowerCase());
  if (!s) throw new EngineError("DBSnapshotNotFound", `DBSnapshot ${name} not found.`, 404);
  return s;
}

const int = (args: Args, name: string): number | undefined => {
  const v = args.one(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`argument --${name}: invalid int value: '${v}'`);
  return n;
};

const LICENSE: Record<string, string> = { postgres: "postgresql-license", mysql: "general-public-license", mariadb: "general-public-license" };
const family = (engine: string, version: string) => `${engine}${engine === "postgres" ? version.split(".")[0] : version.split(".").slice(0, 2).join(".")}`;

// ---------- output shapes ----------

async function subnetGroupOut(ctx: CliContext, g: Resource) {
  const subnets = (await Promise.all(((g.config.subnetIds as string[]) ?? []).map((id) => ctx.engine.get(ctx.accountId, id).catch(() => null)))).filter(
    (s): s is Resource => !!s,
  );
  return {
    DBSubnetGroupName: g.name,
    DBSubnetGroupDescription: g.config.description,
    VpcId: g.attributes.vpcId,
    SubnetGroupStatus: "Complete",
    Subnets: subnets.map((s) => ({
      SubnetIdentifier: s.id,
      SubnetAvailabilityZone: { Name: s.config.availabilityZone },
      SubnetOutpost: {},
      SubnetStatus: "Active",
    })),
    DBSubnetGroupArn: g.id,
    SupportedNetworkTypes: ["IPV4"],
  };
}

async function dbOut(ctx: CliContext, db: Resource, status?: string) {
  const a = db.attributes;
  const engine = String(db.config.engine);
  const version = String(a.engineVersion);
  const group = (await list(ctx, "db-subnet-group")).find((g) => g.name === db.config.dbSubnetGroupName);
  const state = status ?? db.state;
  const pending = { ...((a.pendingModifiedValues as Record<string, unknown> | undefined) ?? {}) };
  if (state === "creating") pending.MasterUserPassword = "****";
  return {
    DBInstanceIdentifier: db.name,
    DBInstanceClass: db.config.dbInstanceClass,
    Engine: engine,
    DBInstanceStatus: state,
    MasterUsername: db.config.masterUsername,
    ...(db.config.dbName ? { DBName: db.config.dbName } : {}),
    // Like RDS, there's no endpoint until the database has been created.
    ...(state === "creating" ? {} : { Endpoint: { Address: a.endpoint, Port: a.port, HostedZoneId: "Z2R2ITUGPM61AM" } }),
    AllocatedStorage: db.config.allocatedStorage,
    ...(state === "creating" ? {} : { InstanceCreateTime: db.createdAt }),
    PreferredBackupWindow: "03:00-03:30",
    BackupRetentionPeriod: db.config.backupRetentionPeriod,
    DBSecurityGroups: [],
    VpcSecurityGroups: ((db.config.vpcSecurityGroupIds as string[]) ?? []).map((id) => ({ VpcSecurityGroupId: id, Status: "active" })),
    DBParameterGroups: [{ DBParameterGroupName: `default.${family(engine, version)}`, ParameterApplyStatus: "in-sync" }],
    AvailabilityZone: a.availabilityZone,
    DBSubnetGroup: group ? await subnetGroupOut(ctx, group) : undefined,
    PreferredMaintenanceWindow: "sun:05:00-sun:05:30",
    PendingModifiedValues: pending,
    ...(a.latestRestorableTime ? { LatestRestorableTime: a.latestRestorableTime } : {}),
    MultiAZ: db.config.multiAZ === true,
    EngineVersion: version,
    AutoMinorVersionUpgrade: true,
    ReadReplicaDBInstanceIdentifiers: [],
    LicenseModel: LICENSE[engine],
    OptionGroupMemberships: [{ OptionGroupName: `default:${engine}-${family(engine, version).replace(engine, "").replace(".", "-")}`, Status: "in-sync" }],
    ...(a.secondaryAvailabilityZone ? { SecondaryAvailabilityZone: a.secondaryAvailabilityZone } : {}),
    PubliclyAccessible: db.config.publiclyAccessible === true,
    StorageType: "gp2",
    DbInstancePort: 0,
    StorageEncrypted: false,
    DbiResourceId: a.dbiResourceId,
    CACertificateIdentifier: "rds-ca-rsa2048-g1",
    CopyTagsToSnapshot: false,
    DBInstanceArn: db.id,
    IAMDatabaseAuthenticationEnabled: false,
    DeletionProtection: db.config.deletionProtection === true,
    TagList: [],
  };
}

function snapshotOut(s: Resource, status?: string) {
  const a = s.attributes;
  const state = status ?? s.state;
  return {
    DBSnapshotIdentifier: s.name,
    DBInstanceIdentifier: s.config.dbInstanceIdentifier,
    ...(state === "creating" ? {} : { SnapshotCreateTime: a.snapshotCreateTime }),
    Engine: a.engine,
    AllocatedStorage: a.allocatedStorage,
    Status: state,
    Port: a.port,
    AvailabilityZone: a.availabilityZone,
    VpcId: a.vpcId,
    InstanceCreateTime: a.instanceCreateTime,
    MasterUsername: a.masterUsername,
    EngineVersion: a.engineVersion,
    LicenseModel: LICENSE[String(a.engine)],
    SnapshotType: a.snapshotType ?? "manual",
    PercentProgress: state === "creating" ? 0 : 100,
    StorageType: "gp2",
    Encrypted: false,
    DBSnapshotArn: s.id,
    IAMDatabaseAuthenticationEnabled: false,
    TagList: [],
  };
}

// ---------- modifications ----------

/** Settings that wait for the maintenance window unless --apply-immediately is given. */
const DEFERRED: Record<string, string> = { dbInstanceClass: "DBInstanceClass", allocatedStorage: "AllocatedStorage", multiAZ: "MultiAZ" };

function modifyPatch(args: Args): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const set = (key: string, v: unknown) => v !== undefined && (patch[key] = v);
  set("dbInstanceClass", args.one("db-instance-class"));
  set("allocatedStorage", int(args, "allocated-storage"));
  set("masterUserPassword", args.one("master-user-password"));
  set("backupRetentionPeriod", int(args, "backup-retention-period"));
  set("publiclyAccessible", args.bool("publicly-accessible"));
  set("multiAZ", args.bool("multi-az"));
  set("deletionProtection", args.bool("deletion-protection"));
  if (args.has("vpc-security-group-ids")) patch.vpcSecurityGroupIds = args.list("vpc-security-group-ids");
  return patch;
}

// ---------- commands ----------

export const RDS_COMMANDS: Command[] = [
  // --- subnet groups ---
  cmd({
    service: "rds",
    operation: "create-db-subnet-group",
    apiName: "CreateDBSubnetGroup",
    summary: "Choose the subnets (two zones or more) a database may live in",
    usage: "--db-subnet-group-name <name> --db-subnet-group-description <text> --subnet-ids <subnet-id> ...",
    mutates: true,
    async run(args, ctx) {
      const g = await create(ctx, "db-subnet-group", {
        name: args.required("db-subnet-group-name").toLowerCase(),
        description: args.required("db-subnet-group-description"),
        subnetIds: args.list("subnet-ids"),
      });
      return { DBSubnetGroup: await subnetGroupOut(ctx, g) };
    },
  }),
  cmd({
    service: "rds",
    operation: "describe-db-subnet-groups",
    apiName: "DescribeDBSubnetGroups",
    summary: "List DB subnet groups",
    usage: "[--db-subnet-group-name <name>]",
    mutates: false,
    async run(args, ctx) {
      const name = args.one("db-subnet-group-name");
      const items = name ? [await groupByName(ctx, name)] : await list(ctx, "db-subnet-group");
      return { DBSubnetGroups: await Promise.all(items.map((g) => subnetGroupOut(ctx, g))) };
    },
  }),
  cmd({
    service: "rds",
    operation: "modify-db-subnet-group",
    apiName: "ModifyDBSubnetGroup",
    summary: "Change a DB subnet group's subnets",
    usage: "--db-subnet-group-name <name> --subnet-ids <subnet-id> ... [--db-subnet-group-description <text>]",
    mutates: true,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("db-subnet-group-name"));
      const subnetIds = args.list("subnet-ids");
      if (subnetIds.length === 0) throw new UsageError("the following arguments are required: --subnet-ids");
      const description = args.one("db-subnet-group-description");
      const updated = await ctx.engine.update(ctx.accountId, g.id, { subnetIds, ...(description ? { description } : {}) });
      return { DBSubnetGroup: await subnetGroupOut(ctx, updated) };
    },
  }),
  cmd({
    service: "rds",
    operation: "delete-db-subnet-group",
    apiName: "DeleteDBSubnetGroup",
    summary: "Delete a DB subnet group",
    usage: "--db-subnet-group-name <name>",
    mutates: true,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("db-subnet-group-name"));
      await ctx.engine.remove(ctx.accountId, g.id);
    },
  }),

  // --- DB instances ---
  cmd({
    service: "rds",
    operation: "create-db-instance",
    apiName: "CreateDBInstance",
    summary: "Create a managed database",
    usage:
      "--db-instance-identifier <id> --db-instance-class <class> --engine postgres|mysql|mariadb --master-username <name> --master-user-password <password> --allocated-storage <GiB> [--engine-version <v>] [--db-name <name>] [--db-subnet-group-name <name>] [--vpc-security-group-ids <sg-id> ...] [--publicly-accessible] [--multi-az] [--backup-retention-period <days>] [--deletion-protection]",
    mutates: true,
    async run(args, ctx) {
      const name = args.required("db-instance-identifier").toLowerCase();
      const dbInstanceClass = args.required("db-instance-class");
      const engine = args.required("engine");
      if (!DB_ENGINES[engine]) throw new EngineError("InvalidParameterValue", `Invalid DB engine: ${engine}`);
      if (args.has("manage-master-user-password")) {
        throw new EngineError("InvalidParameterValue", "CloudLab doesn't simulate Secrets Manager yet; pass --master-user-password.");
      }
      const storage = int(args, "allocated-storage");
      if (storage === undefined) {
        throw new EngineError("InvalidParameterCombination", `Invalid storage size for engine name ${engine} and storage type gp2: 0`);
      }
      const username = args.one("master-username");
      if (!username) throw new EngineError("InvalidParameterValue", "The parameter MasterUsername must be provided and must not be blank.");
      // No subnet group: RDS uses the default VPC, and such databases are publicly accessible by default.
      const named = args.one("db-subnet-group-name");
      const dbSubnetGroupName = named?.toLowerCase() ?? (await ensureDefaultSubnetGroup(ctx.engine, ctx.accountId, ctx.region));
      const sgs = args.list("vpc-security-group-ids");
      const db = await create(ctx, "db-instance", {
        name,
        engine,
        engineVersion: args.one("engine-version"),
        dbInstanceClass,
        allocatedStorage: storage,
        masterUsername: username,
        masterUserPassword: args.one("master-user-password"),
        dbName: args.one("db-name"),
        dbSubnetGroupName,
        vpcSecurityGroupIds: sgs.length ? sgs : await defaultSecurityGroupFor(ctx.engine, ctx.accountId, ctx.region, dbSubnetGroupName),
        publiclyAccessible: args.bool("publicly-accessible") ?? !named,
        multiAZ: args.bool("multi-az") ?? false,
        backupRetentionPeriod: int(args, "backup-retention-period") ?? 1,
        deletionProtection: args.bool("deletion-protection") ?? false,
      });
      return { DBInstance: await dbOut(ctx, db) };
    },
  }),
  cmd({
    service: "rds",
    operation: "describe-db-instances",
    apiName: "DescribeDBInstances",
    summary: "List databases, their status and endpoints",
    usage: "[--db-instance-identifier <id>]",
    mutates: false,
    async run(args, ctx) {
      const name = args.one("db-instance-identifier");
      const items = name ? [await dbByName(ctx, name)] : await list(ctx, "db-instance");
      return { DBInstances: await Promise.all(items.map((d) => dbOut(ctx, d))) };
    },
  }),
  cmd({
    service: "rds",
    operation: "modify-db-instance",
    apiName: "ModifyDBInstance",
    summary: "Change a database (size, storage, Multi-AZ, password…); add --apply-immediately to not wait for the maintenance window",
    usage:
      "--db-instance-identifier <id> [--db-instance-class <class>] [--allocated-storage <GiB>] [--master-user-password <password>] [--vpc-security-group-ids <sg-id> ...] [--publicly-accessible] [--multi-az] [--backup-retention-period <days>] [--deletion-protection] [--apply-immediately]",
    mutates: true,
    async run(args, ctx) {
      const db = await dbByName(ctx, args.required("db-instance-identifier"));
      if (db.state !== "available") throw new EngineError("InvalidDBInstanceState", "Database instance is not in available state.");
      const patch = modifyPatch(args);
      const pending = { ...((db.attributes.pendingModifiedValues as Record<string, unknown> | undefined) ?? {}) };
      const immediately = args.bool("apply-immediately") === true;
      if (immediately) {
        // Earlier deferred changes go now too.
        for (const [key, api] of Object.entries(DEFERRED)) if (pending[api] !== undefined && !(key in patch)) patch[key] = pending[api];
      } else {
        for (const [key, api] of Object.entries(DEFERRED)) {
          if (key in patch && patch[key] !== db.config[key]) pending[api] = patch[key];
          delete patch[key];
        }
      }
      // Check the whole change first, so a bad deferred value fails now, as in RDS.
      if (!immediately && Object.keys(pending).length) {
        const preview: Record<string, unknown> = {};
        for (const [key, api] of Object.entries(DEFERRED)) if (pending[api] !== undefined) preview[key] = pending[api];
        if (Number(preview.allocatedStorage ?? db.config.allocatedStorage) < Number(db.config.allocatedStorage)) {
          throw new EngineError(
            "InvalidParameterCombination",
            `Invalid storage size for engine name ${db.config.engine} and storage type gp2: ${preview.allocatedStorage}. Storage can be increased, not decreased.`,
          );
        }
      }
      const updated = Object.keys(patch).length ? await ctx.engine.update(ctx.accountId, db.id, patch) : db;
      await ctx.engine.setAttributes(ctx.accountId, db.id, { pendingModifiedValues: immediately ? {} : pending });
      const fresh = await ctx.engine.get(ctx.accountId, updated.id);
      const out = await dbOut(ctx, fresh);
      if (patch.masterUserPassword) out.PendingModifiedValues = { ...out.PendingModifiedValues, MasterUserPassword: "****" };
      return { DBInstance: out };
    },
  }),
  cmd({
    service: "rds",
    operation: "delete-db-instance",
    apiName: "DeleteDBInstance",
    summary: "Delete a database (needs --skip-final-snapshot or --final-db-snapshot-identifier)",
    usage: "--db-instance-identifier <id> [--skip-final-snapshot] [--final-db-snapshot-identifier <id>] [--delete-automated-backups]",
    mutates: true,
    async run(args, ctx) {
      const db = await dbByName(ctx, args.required("db-instance-identifier"));
      const finalId = args.one("final-db-snapshot-identifier")?.toLowerCase();
      await ctx.engine.remove(ctx.accountId, db.id, { params: { skipFinalSnapshot: args.bool("skip-final-snapshot") === true, finalSnapshotIdentifier: finalId } });
      return { DBInstance: await dbOut(ctx, db, "deleting") };
    },
  }),
  cmd({
    service: "rds",
    operation: "stop-db-instance",
    apiName: "StopDBInstance",
    summary: "Stop a database (it starts again by itself after 7 days)",
    usage: "--db-instance-identifier <id>",
    mutates: true,
    async run(args, ctx) {
      const db = await dbByName(ctx, args.required("db-instance-identifier"));
      return { DBInstance: await dbOut(ctx, await ctx.engine.runAction(ctx.accountId, db.id, "stop")) };
    },
  }),
  cmd({
    service: "rds",
    operation: "start-db-instance",
    apiName: "StartDBInstance",
    summary: "Start a stopped database",
    usage: "--db-instance-identifier <id>",
    mutates: true,
    async run(args, ctx) {
      const db = await dbByName(ctx, args.required("db-instance-identifier"));
      return { DBInstance: await dbOut(ctx, await ctx.engine.runAction(ctx.accountId, db.id, "start")) };
    },
  }),
  cmd({
    service: "rds",
    operation: "reboot-db-instance",
    apiName: "RebootDBInstance",
    summary: "Reboot a database; --force-failover switches a Multi-AZ database to its standby",
    usage: "--db-instance-identifier <id> [--force-failover]",
    mutates: true,
    async run(args, ctx) {
      const db = await dbByName(ctx, args.required("db-instance-identifier"));
      const action = args.bool("force-failover") ? "failover" : "reboot";
      return { DBInstance: await dbOut(ctx, await ctx.engine.runAction(ctx.accountId, db.id, action)) };
    },
  }),

  // --- snapshots ---
  cmd({
    service: "rds",
    operation: "create-db-snapshot",
    apiName: "CreateDBSnapshot",
    summary: "Back up a database now",
    usage: "--db-snapshot-identifier <id> --db-instance-identifier <id>",
    mutates: true,
    async run(args, ctx) {
      const db = await dbByName(ctx, args.required("db-instance-identifier"));
      const s = await create(ctx, "db-snapshot", { name: args.required("db-snapshot-identifier").toLowerCase(), dbInstanceIdentifier: db.name });
      return { DBSnapshot: snapshotOut(s) };
    },
  }),
  cmd({
    service: "rds",
    operation: "describe-db-snapshots",
    apiName: "DescribeDBSnapshots",
    summary: "List snapshots",
    usage: "[--db-instance-identifier <id>] [--db-snapshot-identifier <id>] [--snapshot-type manual]",
    mutates: false,
    async run(args, ctx) {
      const id = args.one("db-snapshot-identifier");
      const db = args.one("db-instance-identifier")?.toLowerCase();
      const type = args.one("snapshot-type");
      let items = id ? [await snapshotByName(ctx, id)] : await list(ctx, "db-snapshot");
      if (db) items = items.filter((s) => s.config.dbInstanceIdentifier === db);
      if (type) items = items.filter((s) => (s.attributes.snapshotType ?? "manual") === type);
      return { DBSnapshots: items.map((s) => snapshotOut(s)) };
    },
  }),
  cmd({
    service: "rds",
    operation: "delete-db-snapshot",
    apiName: "DeleteDBSnapshot",
    summary: "Delete a snapshot",
    usage: "--db-snapshot-identifier <id>",
    mutates: true,
    async run(args, ctx) {
      const s = await snapshotByName(ctx, args.required("db-snapshot-identifier"));
      if (s.state !== "available") throw new EngineError("InvalidDBSnapshotState", `Cannot delete the snapshot because it is not in the available state.`);
      await ctx.engine.remove(ctx.accountId, s.id);
      return { DBSnapshot: snapshotOut(s, "deleted") };
    },
  }),
  cmd({
    service: "rds",
    operation: "restore-db-instance-from-db-snapshot",
    apiName: "RestoreDBInstanceFromDBSnapshot",
    summary: "Create a new database from a snapshot",
    usage:
      "--db-instance-identifier <id> --db-snapshot-identifier <id> [--db-instance-class <class>] [--db-subnet-group-name <name>] [--vpc-security-group-ids <sg-id> ...] [--publicly-accessible] [--multi-az] [--deletion-protection]",
    mutates: true,
    async run(args, ctx) {
      const snap = await snapshotByName(ctx, args.required("db-snapshot-identifier"));
      if (snap.state !== "available") throw new EngineError("InvalidDBSnapshotState", `Snapshot ${snap.name} is not available.`);
      const a = snap.attributes;
      const groups = await list(ctx, "db-subnet-group");
      const named = args.one("db-subnet-group-name")?.toLowerCase();
      const dbSubnetGroupName =
        named ?? (groups.some((g) => g.name === a.dbSubnetGroupName) ? String(a.dbSubnetGroupName) : await ensureDefaultSubnetGroup(ctx.engine, ctx.accountId, ctx.region));
      const sgs = args.list("vpc-security-group-ids");
      const db = await create(ctx, "db-instance", {
        name: args.required("db-instance-identifier").toLowerCase(),
        snapshotIdentifier: snap.name,
        engine: a.engine,
        engineVersion: a.engineVersion,
        dbInstanceClass: args.one("db-instance-class") ?? a.dbInstanceClass ?? "db.t3.micro",
        allocatedStorage: a.allocatedStorage,
        masterUsername: a.masterUsername,
        dbName: a.dbName ?? undefined,
        dbSubnetGroupName,
        // Like RDS, a restored database gets the VPC's default security group unless you say otherwise.
        vpcSecurityGroupIds: sgs.length ? sgs : await defaultSecurityGroupFor(ctx.engine, ctx.accountId, ctx.region, dbSubnetGroupName),
        publiclyAccessible: args.bool("publicly-accessible") ?? false,
        multiAZ: args.bool("multi-az") ?? false,
        backupRetentionPeriod: 1,
        deletionProtection: args.bool("deletion-protection") ?? false,
      });
      return { DBInstance: await dbOut(ctx, db) };
    },
  }),

  // --- catalogue ---
  cmd({
    service: "rds",
    operation: "describe-db-engine-versions",
    apiName: "DescribeDBEngineVersions",
    summary: "List the engines and versions you can create",
    usage: "[--engine postgres|mysql|mariadb] [--engine-version <v>]",
    mutates: false,
    async run(args) {
      const only = args.one("engine");
      const version = args.one("engine-version");
      if (only && !DB_ENGINES[only]) throw new EngineError("InvalidParameterValue", `Invalid DB engine: ${only}`);
      return {
        DBEngineVersions: Object.entries(DB_ENGINES)
          .filter(([e]) => !only || e === only)
          .flatMap(([engine, e]) =>
            e.versions
              .filter((v) => !version || v === version)
              .map((v) => ({
                Engine: engine,
                EngineVersion: v,
                DBParameterGroupFamily: family(engine, v),
                DBEngineDescription: e.label,
                DBEngineVersionDescription: `${e.label} ${v}`,
                Status: "available",
              })),
          ),
      };
    },
  }),
];
