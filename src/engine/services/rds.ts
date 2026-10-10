import { createHash, randomBytes } from "node:crypto";
import type { Engine } from "../engine";
import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import { systemOf, type FieldDef, type HookContext, type Resource, type ResourceTypeDef, type ServiceDef } from "../types";
import { freePublicIp, nextPrivateIp } from "./ips";

/**
 * Amazon RDS: managed databases. A DB subnet group says which subnets (in at
 * least two zones) a database may live in; a DB instance is the database
 * server, reached by its endpoint name; snapshots are backups you can restore
 * into a new instance. Everything is addressed by identifier (a name), and
 * errors use RDS's own codes (DBInstanceNotFound, InvalidDBInstanceState…).
 */

// ---------- catalogue ----------

export const DB_ENGINES: Record<string, { label: string; versions: string[]; port: number; maxPassword: number; maxUser: number }> = {
  postgres: { label: "PostgreSQL", versions: ["17.2", "16.6", "15.10", "14.15"], port: 5432, maxPassword: 128, maxUser: 63 },
  mysql: { label: "MySQL", versions: ["8.4.3", "8.0.40"], port: 3306, maxPassword: 41, maxUser: 16 },
  mariadb: { label: "MariaDB", versions: ["11.4.4", "10.11.10"], port: 3306, maxPassword: 41, maxUser: 16 },
};

export const DB_CLASSES: { value: string; vcpu: number; memory: number }[] = [
  { value: "db.t3.micro", vcpu: 2, memory: 1 },
  { value: "db.t3.small", vcpu: 2, memory: 2 },
  { value: "db.t3.medium", vcpu: 2, memory: 4 },
  { value: "db.t4g.micro", vcpu: 2, memory: 1 },
  { value: "db.t4g.small", vcpu: 2, memory: 2 },
  { value: "db.m5.large", vcpu: 2, memory: 8 },
  { value: "db.r5.large", vcpu: 2, memory: 16 },
];

/** Usernames the engines keep for themselves. */
const RESERVED_USERS = ["rdsadmin", "rdsrepladmin", "rds_superuser", "user", "select", "table", "database", "root"];

const MIN_STORAGE = 20;
const MAX_STORAGE = 1000;

const arn = (kind: "db" | "subgrp" | "snapshot") => ({ name, region, accountId }: { name: string; region: string; accountId: string }) =>
  `arn:aws:rds:${region}:${accountNumber(accountId)}:${kind}:${name}`;

const arnPattern = (kind: string, name = "[a-z][a-z0-9-]{0,254}") => new RegExp(`^arn:aws:rds:[a-z0-9-]+:\\d{12}:${kind}:${name}$`);

/** RDS identifiers: a letter first, then letters, digits and single hyphens, no hyphen at the end. */
const IDENTIFIER = /^[a-zA-Z](?:-?[a-zA-Z0-9])*$/;

function checkIdentifier(param: string, value: string) {
  if (!IDENTIFIER.test(value) || value.length > 63) {
    throw new EngineError(
      "InvalidParameterValue",
      `The parameter ${param} is not a valid identifier. Identifiers must begin with a letter; must contain only ASCII letters, digits, and hyphens; and must not end with a hyphen or contain two consecutive hyphens.`,
    );
  }
}

/** The endpoint's middle part: fixed per account and region, like AWS's. */
function endpointHash(accountId: string, region: string) {
  return createHash("sha1").update(`${accountId}:${region}`).digest("hex").slice(0, 12);
}

export function endpointOf(db: Resource) {
  return db.attributes.endpoint as string | undefined;
}

const byName = (items: Resource[], name: unknown) => items.find((r) => r.name === name);

// ---------- DB subnet groups ----------

const subnetGroup: ResourceTypeDef = {
  service: "rds",
  type: "db-subnet-group",
  label: "DB subnet group",
  pluralLabel: "Subnet groups",
  description:
    "The subnets a database may be placed in. It must cover at least two availability zones, so RDS has somewhere to put a standby. For a private database, use private subnets.",
  idPrefix: "subgrp",
  makeId: arn("subgrp"),
  idPattern: arnPattern("subgrp", "[a-z0-9._ -]{1,255}"),
  notFoundCode: "DBSubnetGroupNotFoundFault",
  notFoundMessage: (id) => `DBSubnetGroup '${id.split(":").pop()}' not found.`,
  notFoundByNameMessage: (name) => `DBSubnetGroup '${name}' not found.`,
  malformedCode: "DBSubnetGroupNotFoundFault",
  malformedMessage: (id) => `DBSubnetGroup '${id}' not found.`,
  apiNoun: "DB subnet group",
  fields: [
    {
      key: "name",
      label: "Name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 255,
      pattern: "^[a-z0-9._ -]+$",
      patternMessage: "Lowercase letters, numbers, spaces and . _ - only.",
      placeholder: "app-db-subnets",
      param: "DBSubnetGroupName",
    },
    { key: "description", label: "Description", type: "string", required: true, maxLength: 255, placeholder: "Private subnets for the app database", param: "DBSubnetGroupDescription" },
    {
      key: "subnetIds",
      label: "Subnets",
      type: "ref",
      required: true,
      ref: { service: "networking", type: "subnet", multiple: true },
      description: "At least two, in different availability zones, all in one VPC.",
      param: "SubnetIds",
    },
  ],
  columns: [
    { label: "VPC", path: "attributes.vpcId", mono: true },
    { label: "Zones", path: "attributes.availabilityZones" },
  ],
  iam: {
    create: "rds:CreateDBSubnetGroup",
    read: "rds:DescribeDBSubnetGroups",
    update: "rds:ModifyDBSubnetGroup",
    delete: "rds:DeleteDBSubnetGroup",
    arn: (r) => r.id,
  },
  invalidValue({ field, value }) {
    if (field.key === "name") {
      return new EngineError("InvalidParameterValue", `The parameter DBSubnetGroupName is not a valid identifier: ${value}`);
    }
    return undefined;
  },
  async validate({ config, existing, ctx }) {
    if (!existing && byName(await ctx.list("rds", "db-subnet-group"), config.name)) {
      throw new EngineError("DBSubnetGroupAlreadyExists", `The DB subnet group '${config.name}' already exists.`);
    }
    const subnets = (await Promise.all(((config.subnetIds as string[]) ?? []).map((id) => ctx.get(id)))).filter((x): x is Resource => !!x);
    if (new Set(subnets.map((x) => x.config.vpcId)).size > 1) {
      throw new EngineError("InvalidParameterValue", "Some input subnets in :[" + subnets.map((x) => x.id).join(", ") + "] are invalid. All subnets must be in the same VPC.");
    }
    const zones = [...new Set(subnets.map((x) => String(x.config.availabilityZone)))].sort();
    if (zones.length < 2) {
      throw new EngineError(
        "DBSubnetGroupDoesNotCoverEnoughAZs",
        `The DB subnet group doesn't meet Availability Zone (AZ) coverage requirement. Current AZ coverage: ${zones.join(", ") || "none"}. Add subnets to cover at least 2 AZs.`,
      );
    }
    if (existing) {
      // Subnets that a database lives in can't be taken out of its group.
      const dbs = (await ctx.list("rds", "db-instance")).filter((d) => d.config.dbSubnetGroupName === existing.name);
      const kept = new Set(config.subnetIds as string[]);
      const inUse = dbs.flatMap((d) => [d.attributes.subnetId, d.attributes.standbySubnetId]).filter((s): s is string => typeof s === "string" && !kept.has(s));
      if (inUse.length) throw new EngineError("InvalidSubnet", `Some of the subnets to be deleted are currently in use: ${[...new Set(inUse)].join(", ")}`);
      if (dbs.length && subnets[0] && subnets[0].config.vpcId !== existing.attributes.vpcId) {
        throw new EngineError("InvalidParameterValue", "The new subnets are not in the same VPC as the DB instances using this group.");
      }
    }
  },
  async derive({ config, ctx }) {
    const subnets = (await Promise.all(((config.subnetIds as string[]) ?? []).map((id) => ctx.get(id)))).filter((x): x is Resource => !!x);
    return {
      vpcId: subnets[0]?.config.vpcId ?? null,
      availabilityZones: [...new Set(subnets.map((x) => String(x.config.availabilityZone)))].sort(),
      subnetGroupStatus: "Complete",
    };
  },
  async beforeDelete({ resource, ctx }) {
    const user = (await ctx.list("rds", "db-instance")).find((d) => d.config.dbSubnetGroupName === resource.name);
    if (user) {
      throw new EngineError(
        "InvalidDBSubnetGroupStateFault",
        `Cannot delete the subnet group '${resource.name}' because at least one database instance: ${user.name} is still using it.`,
      );
    }
  },
};

/**
 * The "default" DB subnet group RDS uses when none is named: every subnet of the
 * default VPC. Created the first time it's needed.
 */
export async function ensureDefaultSubnetGroup(engine: Engine, accountId: string, region: string): Promise<string> {
  const groups = await engine.list(accountId, { service: "rds", type: "db-subnet-group", region });
  if (byName(groups, "default")) return "default";
  const vpc = await engine.defaultVpc(accountId, region);
  const subnets = vpc ? (await engine.list(accountId, { service: "networking", type: "subnet", region })).filter((x) => x.config.vpcId === vpc.id) : [];
  if (!vpc || subnets.length < 2) {
    throw new EngineError("InvalidVPCNetworkStateFault", "No default subnet detected in VPC. Create a DB subnet group and pass --db-subnet-group-name.");
  }
  await engine.create(
    accountId,
    { service: "rds", type: "db-subnet-group", region, config: { name: "default", description: "default", subnetIds: subnets.map((x) => x.id) } },
    { system: { isDefault: true } },
  );
  return "default";
}

// ---------- DB instances ----------

const dbStateMessage = () => "Database instance is not in available state.";

const identifierField = (placeholder: string, param: string): FieldDef => ({
  key: "name",
  label: param === "DBSnapshotIdentifier" ? "Snapshot identifier" : "DB instance identifier",
  type: "string",
  required: true,
  immutable: true,
  maxLength: 63,
  pattern: "^[a-z](?:-?[a-z0-9])*$",
  patternMessage: "Lowercase letters, numbers and single hyphens; starts with a letter, doesn't end with a hyphen.",
  placeholder,
  param,
});

const dbInstance: ResourceTypeDef = {
  service: "rds",
  type: "db-instance",
  label: "Database",
  pluralLabel: "Databases",
  description:
    "A managed database server (PostgreSQL, MySQL or MariaDB). RDS runs it, backs it up and can keep a standby copy in another zone. Your app connects to its endpoint name.",
  idPrefix: "db",
  makeId: arn("db"),
  idPattern: arnPattern("db"),
  notFoundCode: "DBInstanceNotFound",
  notFoundMessage: (id) => `DBInstance ${id.split(":").pop()} not found.`,
  notFoundByNameMessage: (name) => `DBInstance ${name} not found.`,
  malformedCode: "DBInstanceNotFound",
  malformedMessage: (id) => `DBInstance ${id} not found.`,
  apiNoun: "DB instance",
  stateErrorCode: "InvalidDBInstanceState",
  panelAttributes: ["passwordChangedAt", "dbiResourceId"],
  fields: [
    identifierField("app-db", "DBInstanceIdentifier"),
    {
      key: "engine",
      label: "Engine",
      type: "enum",
      required: true,
      immutable: true,
      default: "postgres",
      param: "Engine",
      options: Object.entries(DB_ENGINES).map(([value, e]) => ({ value, label: e.label, hint: `port ${e.port}` })),
    },
    {
      key: "engineVersion",
      label: "Engine version",
      type: "enum",
      immutable: true,
      param: "EngineVersion",
      options: Object.entries(DB_ENGINES).flatMap(([, e]) => e.versions.map((v) => ({ value: v, label: `${e.label} ${v}` }))),
      description: "Leave empty for the newest version of the engine.",
    },
    {
      key: "dbInstanceClass",
      label: "Instance class",
      type: "enum",
      required: true,
      default: "db.t3.micro",
      param: "DBInstanceClass",
      mutableInStates: ["available"],
      options: DB_CLASSES.map((c) => ({ value: c.value, label: c.value, hint: `${c.vcpu} vCPU, ${c.memory} GiB` })),
    },
    {
      key: "allocatedStorage",
      label: "Storage (GiB)",
      type: "number",
      required: true,
      default: MIN_STORAGE,
      min: MIN_STORAGE,
      max: MAX_STORAGE,
      param: "AllocatedStorage",
      mutableInStates: ["available"],
      description: "Can grow later, never shrink.",
    },
    {
      key: "masterUsername",
      label: "Master username",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 63,
      pattern: "^[a-zA-Z][a-zA-Z0-9_]*$",
      patternMessage: "Starts with a letter; letters, numbers and underscores only.",
      placeholder: "app",
      param: "MasterUsername",
    },
    {
      key: "masterUserPassword",
      label: "Master password",
      type: "string",
      secret: true,
      maxLength: 128,
      param: "MasterUserPassword",
      mutableInStates: ["available"],
      description: "At least 8 characters, without / @ \" or spaces. Never shown again; on an existing database, leave empty to keep it.",
    },
    {
      key: "dbName",
      label: "Initial database name",
      type: "string",
      immutable: true,
      maxLength: 63,
      pattern: "^[a-zA-Z][a-zA-Z0-9_]*$",
      patternMessage: "Starts with a letter; letters, numbers and underscores only.",
      placeholder: "app",
      param: "DBName",
    },
    {
      key: "dbSubnetGroupName",
      label: "DB subnet group",
      type: "ref",
      required: true,
      immutable: true,
      ref: { service: "rds", type: "db-subnet-group", by: "name" },
      param: "DBSubnetGroupName",
      description: "Decides the VPC and the zones the database can use.",
    },
    {
      key: "vpcSecurityGroupIds",
      label: "Security groups",
      type: "ref",
      required: true,
      ref: { service: "networking", type: "security-group", multiple: true },
      param: "VpcSecurityGroupIds",
      description: "Allow the database port (5432 or 3306) only from your app servers' security group.",
    },
    {
      key: "publiclyAccessible",
      label: "Publicly accessible",
      type: "boolean",
      default: false,
      param: "PubliclyAccessible",
      mutableInStates: ["available"],
      description: "Gives the endpoint a public IP. Almost always leave this off: databases belong in private subnets.",
    },
    {
      key: "multiAZ",
      label: "Multi-AZ (standby in another zone)",
      type: "boolean",
      default: false,
      param: "MultiAZ",
      mutableInStates: ["available"],
      description: "RDS keeps a standby copy in a second zone and fails over to it if the first has a problem. Same endpoint either way.",
    },
    {
      key: "backupRetentionPeriod",
      label: "Backup retention (days)",
      type: "number",
      default: 7,
      min: 0,
      max: 35,
      param: "BackupRetentionPeriod",
      mutableInStates: ["available"],
      description: "Automated daily backups are kept this long. 0 turns them off.",
    },
    {
      key: "deletionProtection",
      label: "Deletion protection",
      type: "boolean",
      default: false,
      param: "DeletionProtection",
      description: "When on, the database can't be deleted until you turn it off.",
    },
    {
      key: "snapshotIdentifier",
      label: "Restore from snapshot",
      type: "ref",
      immutable: true,
      ref: { service: "rds", type: "db-snapshot", by: "name" },
      param: "DBSnapshotIdentifier",
      description: "Optional: start from a snapshot's data instead of an empty database.",
    },
  ],
  columns: [
    { label: "Engine", path: "config.engine" },
    { label: "Class", path: "config.dbInstanceClass" },
    { label: "Zone", path: "attributes.availabilityZone" },
    { label: "Multi-AZ", path: "config.multiAZ", boolean: true },
  ],
  lifecycle: {
    create: { state: "creating", settlesTo: "available", afterMs: 15_000 },
    actions: {
      stop: {
        label: "Stop",
        from: ["available"],
        via: "stopping",
        to: "stopped",
        pastTense: "stopped",
        afterMs: 5_000,
        strict: true,
        description: "Stops the database (storage is kept). AWS starts it again automatically after 7 days.",
        stateErrorMessage: (r) => `Instance ${r.name} is not in available state.`,
      },
      start: {
        label: "Start",
        from: ["stopped"],
        via: "starting",
        to: "available",
        pastTense: "started",
        afterMs: 8_000,
        strict: true,
        stateErrorMessage: (r) => `Instance ${r.name} is not stopped, cannot be started.`,
      },
      reboot: {
        label: "Reboot",
        from: ["available"],
        via: "rebooting",
        to: "available",
        pastTense: "rebooted",
        afterMs: 5_000,
        strict: true,
        stateErrorMessage: dbStateMessage,
      },
      failover: {
        label: "Reboot with failover",
        description: "Switches to the standby in the other zone, as RDS does when a zone fails.",
        from: ["available"],
        via: "rebooting",
        to: "available",
        pastTense: "rebooted",
        afterMs: 6_000,
        strict: true,
        stateErrorMessage: dbStateMessage,
      },
      apply: {
        label: "Apply changes",
        hidden: true,
        from: ["available"],
        via: "modifying",
        to: "available",
        pastTense: "modified",
        afterMs: 5_000,
        strict: true,
        stateErrorMessage: dbStateMessage,
      },
    },
  },
  iam: {
    create: "rds:CreateDBInstance",
    read: "rds:DescribeDBInstances",
    update: "rds:ModifyDBInstance",
    delete: "rds:DeleteDBInstance",
    actions: { stop: "rds:StopDBInstance", start: "rds:StartDBInstance", reboot: "rds:RebootDBInstance", failover: "rds:RebootDBInstance" },
    arn: (r) => r.id,
  },
  invalidValue({ field, value }) {
    if (field.key === "name") return checkIdentifierError("DBInstanceIdentifier");
    if (field.key === "allocatedStorage") {
      return new EngineError("InvalidParameterCombination", `Invalid storage size for storage type gp2: ${value}. CloudLab allows ${MIN_STORAGE} to ${MAX_STORAGE} GiB.`);
    }
    if (field.key === "dbInstanceClass") {
      return new EngineError("InvalidParameterCombination", `RDS does not support creating a DB instance with the following combination: DBInstanceClass=${value}.`);
    }
    if (field.key === "engine") return new EngineError("InvalidParameterValue", `Invalid DB engine: ${value}`);
    if (field.key === "masterUserPassword") {
      return new EngineError("InvalidParameterValue", "The parameter MasterUserPassword is not a valid password because it is longer than 128 characters.");
    }
    if (field.key === "masterUsername") {
      return new EngineError("InvalidParameterValue", "MasterUsername must start with a letter and contain only letters, numbers and underscores.");
    }
    return undefined;
  },
  async validate({ config, existing, ctx }) {
    const engine = DB_ENGINES[String(config.engine)];
    const name = String(config.name);
    checkIdentifier("DBInstanceIdentifier", name);
    if (!existing && byName(await ctx.list("rds", "db-instance"), name)) {
      throw new EngineError("DBInstanceAlreadyExists", "DB instance already exists");
    }

    // Restoring from a snapshot: its engine, user and data come with it.
    const snapshot = config.snapshotIdentifier ? byName(await ctx.list("rds", "db-snapshot"), config.snapshotIdentifier) : undefined;
    if (!existing && snapshot) {
      if (snapshot.state !== "available") throw new EngineError("InvalidDBSnapshotState", `Snapshot ${snapshot.name} is not available.`);
      if (snapshot.attributes.engine !== config.engine) {
        throw new EngineError(
          "InvalidParameterCombination",
          `The engine of the snapshot (${snapshot.attributes.engine}) doesn't match the requested engine (${config.engine}).`,
        );
      }
      if (Number(config.allocatedStorage) < Number(snapshot.attributes.allocatedStorage)) {
        throw new EngineError(
          "InvalidParameterValue",
          `The requested storage (${config.allocatedStorage} GiB) is smaller than the snapshot's (${snapshot.attributes.allocatedStorage} GiB).`,
        );
      }
    }

    if (config.engineVersion && !engine.versions.includes(String(config.engineVersion))) {
      throw new EngineError("InvalidParameterCombination", `Cannot find version ${config.engineVersion} for ${config.engine}`);
    }

    const user = String(config.masterUsername);
    if (user.length > engine.maxUser) {
      throw new EngineError("InvalidParameterValue", `MasterUsername must be between 1 and ${engine.maxUser} characters for ${engine.label}.`);
    }
    if (RESERVED_USERS.includes(user.toLowerCase())) {
      throw new EngineError("InvalidParameterValue", `MasterUsername ${user} cannot be used as it is a reserved word used by the engine`);
    }

    const password = config.masterUserPassword as string | undefined;
    if (!existing && !snapshot && !password) {
      throw new EngineError("InvalidParameterValue", "The parameter MasterUserPassword must be provided and must not be blank.");
    }
    if (password) {
      if (password.length < 8) {
        throw new EngineError("InvalidParameterValue", "The parameter MasterUserPassword is not a valid password because it is shorter than 8 characters.");
      }
      if (password.length > engine.maxPassword) {
        throw new EngineError(
          "InvalidParameterValue",
          `The parameter MasterUserPassword is not a valid password because it is longer than ${engine.maxPassword} characters.`,
        );
      }
      if (/[/@" ]/.test(password) || /[^\x20-\x7e]/.test(password)) {
        throw new EngineError(
          "InvalidParameterValue",
          "The parameter MasterUserPassword is not a valid password. Only printable ASCII characters besides '/', '@', '\"', ' ' may be used.",
        );
      }
    }

    if (existing && Number(config.allocatedStorage) < Number(existing.config.allocatedStorage)) {
      throw new EngineError(
        "InvalidParameterCombination",
        `Invalid storage size for engine name ${config.engine} and storage type gp2: ${config.allocatedStorage}. Storage can be increased, not decreased.`,
      );
    }

    const group = byName(await ctx.list("rds", "db-subnet-group"), config.dbSubnetGroupName);
    const vpcId = group?.attributes.vpcId as string | undefined;
    for (const sgId of (config.vpcSecurityGroupIds as string[]) ?? []) {
      const sg = await ctx.get(sgId);
      if (sg && vpcId && sg.config.vpcId !== vpcId) {
        throw new EngineError(
          "InvalidParameterCombination",
          `The DB instance and EC2 security group are in different VPCs. The DB instance is in ${vpcId} and the EC2 security group is in ${sg.config.vpcId}`,
        );
      }
    }
    if (config.publiclyAccessible && vpcId && !(await ctx.list("networking", "internet-gateway")).some((g) => g.config.vpcId === vpcId)) {
      throw new EngineError(
        "InvalidVPCNetworkStateFault",
        "Cannot create a publicly accessible DBInstance. The specified VPC has no internet gateway attached.Update the VPC and then try again",
      );
    }
  },
  async derive({ id, config, existing, ctx }) {
    const engine = DB_ENGINES[String(config.engine)];
    const now = ctx.now().toISOString();
    const passwordChangedAt = config.masterUserPassword ? now : (existing?.attributes.passwordChangedAt ?? null);
    const base = existing?.attributes ?? (await placement(config, ctx));

    // Changes after creation: a standby appears or goes, a public address is given or taken back.
    let { standbySubnetId, standbyPrivateIp, secondaryAvailabilityZone, publicIp } = base as Record<string, string | null>;
    if (existing) {
      if (config.multiAZ && !standbySubnetId) {
        const standby = await standbyPlacement(config, ctx, String(base.availabilityZone), [String(base.privateIp)]);
        ({ standbySubnetId, standbyPrivateIp, secondaryAvailabilityZone } = standby);
      }
      if (!config.multiAZ) standbySubnetId = standbyPrivateIp = secondaryAvailabilityZone = null;
      if (config.publiclyAccessible && !publicIp) publicIp = await freePublicIp(ctx.list);
      if (!config.publiclyAccessible) publicIp = null;
    }

    const snapshot = !existing && config.snapshotIdentifier ? byName(await ctx.list("rds", "db-snapshot"), config.snapshotIdentifier) : undefined;
    return {
      ...base,
      standbySubnetId,
      standbyPrivateIp,
      secondaryAvailabilityZone,
      publicIp,
      engineVersion: config.engineVersion || base.engineVersion || engine.versions[0],
      port: engine.port,
      endpoint: `${config.name}.${endpointHash(ctx.accountId, ctx.region)}.${ctx.region}.rds.cloudlab.local`,
      dbiResourceId: base.dbiResourceId ?? `db-${randomBytes(13).toString("hex").toUpperCase().slice(0, 26)}`,
      arn: id,
      passwordChangedAt,
      restoredFrom: existing ? (existing.attributes.restoredFrom ?? null) : (snapshot?.name ?? null),
      latestRestorableTime: Number(config.backupRetentionPeriod) > 0 ? now : null,
      failovers: base.failovers ?? 0,
    };
  },
  async afterUpdate({ resource, previous, system }) {
    // Modifications apply straight away (as with --apply-immediately): the database shows "modifying" for a moment.
    const changed =
      JSON.stringify({ ...resource.config, deletionProtection: null }) !== JSON.stringify({ ...previous.config, deletionProtection: null }) ||
      resource.attributes.passwordChangedAt !== previous.attributes.passwordChangedAt;
    if (changed && resource.state === "available") await system.runAction(resource.id, "apply");
  },
  async beforeAction({ resource, action, ctx }) {
    if (action !== "failover") return;
    if (!resource.config.multiAZ) {
      throw new EngineError("InvalidParameterCombination", "Reboot with failover is only possible for a Multi-AZ DB instance.");
    }
    // The standby takes over: zone, subnet and address swap; the endpoint name stays the same.
    const a = resource.attributes;
    return {
      availabilityZone: a.secondaryAvailabilityZone,
      secondaryAvailabilityZone: a.availabilityZone,
      subnetId: a.standbySubnetId,
      standbySubnetId: a.subnetId,
      privateIp: a.standbyPrivateIp,
      standbyPrivateIp: a.privateIp,
      failovers: Number(a.failovers ?? 0) + 1,
      lastFailoverAt: ctx.now().toISOString(),
    };
  },
  async beforeDelete({ resource, params, system }) {
    if (resource.config.deletionProtection) {
      throw new EngineError("InvalidParameterCombination", "Cannot delete protected DB Instance, please disable deletion protection and try again.");
    }
    const skip = params.skipFinalSnapshot === true;
    const finalId = params.finalSnapshotIdentifier as string | undefined;
    if (skip && finalId) {
      throw new EngineError("InvalidParameterCombination", "FinalDBSnapshotIdentifier can not be specified when deleting a DB instance with SkipFinalSnapshot set to true.");
    }
    if (!skip && !finalId) {
      throw new EngineError("InvalidParameterCombination", "FinalDBSnapshotIdentifier is required unless SkipFinalSnapshot is specified.");
    }
    if (finalId) {
      if (resource.state !== "available" && resource.state !== "stopped") {
        throw new EngineError("InvalidDBInstanceState", `Instance is currently ${resource.state} - a final snapshot cannot be taken.`);
      }
      await system.create("rds", "db-snapshot", { name: finalId, dbInstanceIdentifier: resource.name });
    }
  },
};

function checkIdentifierError(param: string) {
  return new EngineError(
    "InvalidParameterValue",
    `The parameter ${param} is not a valid identifier. Identifiers must begin with a letter; must contain only ASCII letters, digits, and hyphens; and must not end with a hyphen or contain two consecutive hyphens.`,
  );
}

/** Where a new database lives: the first subnet of its group (by zone), plus a standby in another zone for Multi-AZ. */
async function placement(config: Record<string, unknown>, ctx: HookContext): Promise<Record<string, unknown>> {
  const group = byName(await ctx.list("rds", "db-subnet-group"), config.dbSubnetGroupName);
  const subnets = await subnetsOf(group, ctx);
  const primary = subnets[0];
  if (!primary) return {};
  const privateIp = await nextPrivateIp(ctx.list, primary);
  const standby = config.multiAZ ? await standbyPlacement(config, ctx, String(primary.config.availabilityZone), [String(privateIp)]) : {};
  return {
    vpcId: primary.config.vpcId,
    subnetId: primary.id,
    availabilityZone: primary.config.availabilityZone,
    privateIp,
    publicIp: config.publiclyAccessible ? await freePublicIp(ctx.list) : null,
    ...standby,
  };
}

async function subnetsOf(group: Resource | undefined, ctx: HookContext): Promise<Resource[]> {
  const subnets = (await Promise.all(((group?.config.subnetIds as string[]) ?? []).map((id) => ctx.get(id)))).filter((x): x is Resource => !!x);
  return subnets.sort((a, b) => String(a.config.availabilityZone).localeCompare(String(b.config.availabilityZone)) || a.id.localeCompare(b.id));
}

async function standbyPlacement(config: Record<string, unknown>, ctx: HookContext, primaryZone: string, taken: string[]) {
  const group = byName(await ctx.list("rds", "db-subnet-group"), config.dbSubnetGroupName);
  const other = (await subnetsOf(group, ctx)).find((x) => x.config.availabilityZone !== primaryZone);
  if (!other) return { standbySubnetId: null, standbyPrivateIp: null, secondaryAvailabilityZone: null };
  return {
    standbySubnetId: other.id,
    standbyPrivateIp: await nextPrivateIp(ctx.list, other, taken),
    secondaryAvailabilityZone: other.config.availabilityZone as string,
  };
}

// ---------- snapshots ----------

const snapshot: ResourceTypeDef = {
  service: "rds",
  type: "db-snapshot",
  label: "Snapshot",
  pluralLabel: "Snapshots",
  description: "A backup of a whole database at one moment. You can restore it into a new database, for example to recover from a mistake or to make a test copy.",
  idPrefix: "snapshot",
  makeId: arn("snapshot"),
  idPattern: arnPattern("snapshot"),
  notFoundCode: "DBSnapshotNotFound",
  notFoundMessage: (id) => `DBSnapshot ${id.split(":").pop()} not found.`,
  notFoundByNameMessage: (name) => `DBSnapshot ${name} not found.`,
  malformedCode: "DBSnapshotNotFound",
  malformedMessage: (id) => `DBSnapshot ${id} not found.`,
  apiNoun: "DB snapshot",
  stateErrorCode: "InvalidDBSnapshotState",
  fields: [
    identifierField("app-db-before-migration", "DBSnapshotIdentifier"),
    {
      key: "dbInstanceIdentifier",
      label: "Database",
      type: "ref",
      required: true,
      immutable: true,
      ref: { service: "rds", type: "db-instance", by: "name" },
      param: "DBInstanceIdentifier",
    },
  ],
  columns: [
    { label: "Database", path: "config.dbInstanceIdentifier" },
    { label: "Engine", path: "attributes.engine" },
    { label: "Size (GiB)", path: "attributes.allocatedStorage" },
  ],
  lifecycle: { create: { state: "creating", settlesTo: "available", afterMs: 5_000 } },
  iam: {
    create: "rds:CreateDBSnapshot",
    read: "rds:DescribeDBSnapshots",
    delete: "rds:DeleteDBSnapshot",
    arn: (r) => r.id,
  },
  invalidValue({ field }) {
    if (field.key === "name") return checkIdentifierError("DBSnapshotIdentifier");
    return undefined;
  },
  async validate({ config, existing, ctx }) {
    if (existing) return;
    checkIdentifier("DBSnapshotIdentifier", String(config.name));
    if (byName(await ctx.list("rds", "db-snapshot"), config.name)) {
      throw new EngineError("DBSnapshotAlreadyExists", `Cannot create the snapshot because a snapshot with the identifier ${config.name} already exists.`);
    }
    const db = byName(await ctx.list("rds", "db-instance"), config.dbInstanceIdentifier);
    if (db && db.state !== "available" && db.state !== "stopped") {
      throw new EngineError(
        "InvalidDBInstanceState",
        `Cannot create a snapshot because the database instance ${db.name} is not currently in the available state.`,
      );
    }
  },
  async derive({ config, existing, ctx }) {
    if (existing) return existing.attributes;
    const db = byName(await ctx.list("rds", "db-instance"), config.dbInstanceIdentifier);
    if (!db) return {};
    return {
      engine: db.config.engine,
      engineVersion: db.attributes.engineVersion,
      allocatedStorage: db.config.allocatedStorage,
      masterUsername: db.config.masterUsername,
      dbName: db.config.dbName ?? null,
      port: db.attributes.port,
      vpcId: db.attributes.vpcId,
      availabilityZone: db.attributes.availabilityZone,
      dbSubnetGroupName: db.config.dbSubnetGroupName,
      dbInstanceClass: db.config.dbInstanceClass,
      instanceCreateTime: db.createdAt,
      snapshotCreateTime: ctx.now().toISOString(),
      snapshotType: "manual",
    };
  },
};

export const rdsService: ServiceDef = {
  id: "rds",
  label: "Databases",
  modelledOn: "RDS",
  description: "Managed PostgreSQL, MySQL and MariaDB databases with backups, snapshots and a standby in another zone.",
  category: "Database",
  types: [dbInstance, subnetGroup, snapshot],
};

/** The database's default security group choice: the VPC's "default" group. */
export async function defaultSecurityGroupFor(engine: Engine, accountId: string, region: string, subnetGroupName: string): Promise<string[]> {
  const group = byName(await engine.list(accountId, { service: "rds", type: "db-subnet-group", region }), subnetGroupName);
  const vpcId = group?.attributes.vpcId;
  const sg = (await engine.list(accountId, { service: "networking", type: "security-group", region })).find(
    (g) => g.config.vpcId === vpcId && systemOf(g).isDefault,
  );
  return sg ? [sg.id] : [];
}
