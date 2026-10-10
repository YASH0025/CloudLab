import { beforeEach, describe, expect, it } from "vitest";
import { analyzeDbConnection } from "./analysis/dbconnect";
import { Engine } from "./engine";
import { MemoryStore } from "./store";

const A = "acct-rds";
const R = "us-east-1";
let clock: Date;
let engine: Engine;
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const create = (service: string, type: string, config: Record<string, unknown>) => engine.create(A, { service, type, region: R, config });

/** A VPC with a public subnet (web) and two private subnets in two zones (database). */
async function network() {
  const vpc = await create("networking", "vpc", { cidrBlock: "10.0.0.0/16" });
  later(2000);
  const pub = await create("networking", "subnet", { vpcId: vpc.id, cidrBlock: "10.0.1.0/24", availabilityZone: "us-east-1a", mapPublicIpOnLaunch: true });
  const privA = await create("networking", "subnet", { vpcId: vpc.id, cidrBlock: "10.0.11.0/24", availabilityZone: "us-east-1a" });
  const privB = await create("networking", "subnet", { vpcId: vpc.id, cidrBlock: "10.0.12.0/24", availabilityZone: "us-east-1b" });
  const igw = await create("networking", "internet-gateway", { vpcId: vpc.id });
  await create("networking", "route-table", { vpcId: vpc.id, routes: [{ destination: "0.0.0.0/0", gatewayId: igw.id }], subnetIds: [pub.id] });
  const web = await create("networking", "security-group", { name: "web", description: "web", vpcId: vpc.id, inboundRules: [] });
  const dbSg = await create("networking", "security-group", {
    name: "db",
    description: "db",
    vpcId: vpc.id,
    inboundRules: [{ protocol: "tcp", fromPort: 5432, toPort: 5432, sourceGroupId: web.id }],
  });
  return { vpc, pub, privA, privB, web, dbSg };
}

const base = (n: Awaited<ReturnType<typeof network>>, extra: Record<string, unknown> = {}) => ({
  name: "app-db",
  engine: "postgres",
  dbInstanceClass: "db.t3.micro",
  allocatedStorage: 20,
  masterUsername: "app",
  masterUserPassword: "s3cret-pass",
  dbSubnetGroupName: "app-db-subnets",
  vpcSecurityGroupIds: [n.dbSg.id],
  ...extra,
});

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("RDS", () => {
  it("needs a subnet group in two zones", async () => {
    const n = await network();
    await expect(create("rds", "db-subnet-group", { name: "one", description: "x", subnetIds: [n.privA.id] })).rejects.toMatchObject({
      code: "DBSubnetGroupDoesNotCoverEnoughAZs",
      message: "The DB subnet group doesn't meet Availability Zone (AZ) coverage requirement. Current AZ coverage: us-east-1a. Add subnets to cover at least 2 AZs.",
    });
    const g = await create("rds", "db-subnet-group", { name: "app-db-subnets", description: "x", subnetIds: [n.privA.id, n.privB.id] });
    expect(g.attributes.availabilityZones).toEqual(["us-east-1a", "us-east-1b"]);
    await expect(create("rds", "db-instance", base(n, { dbSubnetGroupName: "nope" }))).rejects.toMatchObject({
      code: "DBSubnetGroupNotFoundFault",
      message: "DBSubnetGroup 'nope' not found.",
    });
  });

  it("validates like RDS and never stores the password", async () => {
    const n = await network();
    await create("rds", "db-subnet-group", { name: "app-db-subnets", description: "x", subnetIds: [n.privA.id, n.privB.id] });
    await expect(create("rds", "db-instance", base(n, { masterUserPassword: "short" }))).rejects.toMatchObject({
      message: "The parameter MasterUserPassword is not a valid password because it is shorter than 8 characters.",
    });
    await expect(create("rds", "db-instance", base(n, { masterUserPassword: "has space1" }))).rejects.toMatchObject({ code: "InvalidParameterValue" });
    await expect(create("rds", "db-instance", base(n, { masterUserPassword: undefined }))).rejects.toMatchObject({
      message: "The parameter MasterUserPassword must be provided and must not be blank.",
    });
    await expect(create("rds", "db-instance", base(n, { name: "bad--name" }))).rejects.toMatchObject({ code: "InvalidParameterValue" });
    await expect(create("rds", "db-instance", base(n, { engineVersion: "8.0.40" }))).rejects.toMatchObject({
      code: "InvalidParameterCombination",
      message: "Cannot find version 8.0.40 for postgres",
    });
    await expect(create("rds", "db-instance", base(n, { publiclyAccessible: true, dbSubnetGroupName: "app-db-subnets" }))).resolves.toBeDefined();
    await engine.remove(A, (await engine.list(A, { service: "rds", type: "db-instance", region: R }))[0].id, { params: { skipFinalSnapshot: true } });

    const db = await create("rds", "db-instance", base(n));
    expect(db.config.masterUserPassword).toBeUndefined();
    expect(JSON.stringify(await engine.get(A, db.id))).not.toContain("s3cret-pass");
    expect(db.state).toBe("creating");
    expect(db.attributes).toMatchObject({ port: 5432, engineVersion: "17.2", availabilityZone: "us-east-1a", privateIp: "10.0.11.4", publicIp: null });
    expect(db.attributes.endpoint).toMatch(/^app-db\.[0-9a-f]{12}\.us-east-1\.rds\.cloudlab\.local$/);
    await expect(create("rds", "db-instance", base(n))).rejects.toMatchObject({ code: "DBInstanceAlreadyExists" });
  });

  it("modifies, fails over, snapshots, restores and protects against deletion", async () => {
    const n = await network();
    await create("rds", "db-subnet-group", { name: "app-db-subnets", description: "x", subnetIds: [n.privA.id, n.privB.id] });
    const db = await create("rds", "db-instance", base(n));
    await expect(engine.update(A, db.id, { allocatedStorage: 50 })).rejects.toMatchObject({ code: "InvalidDBInstanceState" });
    later(16_000);

    // Multi-AZ adds a standby in the other zone; modifications show "modifying" for a moment.
    let r = await engine.update(A, db.id, { multiAZ: true, allocatedStorage: 50 });
    r = await engine.get(A, db.id);
    expect(r.state).toBe("modifying");
    expect(r.attributes.secondaryAvailabilityZone).toBe("us-east-1b");
    await expect(engine.update(A, db.id, { allocatedStorage: 30 })).rejects.toMatchObject({ code: "InvalidDBInstanceState" });
    later(6_000);
    await expect(engine.update(A, db.id, { allocatedStorage: 30 })).rejects.toMatchObject({ code: "InvalidParameterCombination" });

    // Failover: the standby's zone becomes the primary's, the endpoint stays.
    const endpoint = (await engine.get(A, db.id)).attributes.endpoint;
    await engine.runAction(A, db.id, "failover");
    later(7_000);
    r = await engine.get(A, db.id);
    expect(r.attributes).toMatchObject({ availabilityZone: "us-east-1b", secondaryAvailabilityZone: "us-east-1a", endpoint, failovers: 1 });

    // Stop / start follow RDS's rules and messages.
    await expect(engine.runAction(A, db.id, "start")).rejects.toMatchObject({
      code: "InvalidDBInstanceState",
      message: "Instance app-db is not stopped, cannot be started.",
    });

    const snap = await create("rds", "db-snapshot", { name: "before-change", dbInstanceIdentifier: "app-db" });
    expect(snap.state).toBe("creating");
    expect(snap.attributes).toMatchObject({ engine: "postgres", allocatedStorage: 50, masterUsername: "app" });
    later(6_000);
    const copy = await create("rds", "db-instance", {
      ...base(n, { name: "app-db-copy", allocatedStorage: 50, snapshotIdentifier: "before-change" }),
      masterUserPassword: undefined,
    });
    expect(copy.attributes.restoredFrom).toBe("before-change");

    await engine.update(A, db.id, { deletionProtection: true });
    await expect(engine.remove(A, db.id, { params: { skipFinalSnapshot: true } })).rejects.toMatchObject({
      message: "Cannot delete protected DB Instance, please disable deletion protection and try again.",
    });
    await engine.update(A, db.id, { deletionProtection: false });
    await expect(engine.remove(A, db.id)).rejects.toMatchObject({
      message: "FinalDBSnapshotIdentifier is required unless SkipFinalSnapshot is specified.",
    });
    later(6_000);
    await engine.remove(A, db.id, { params: { finalSnapshotIdentifier: "app-db-final" } });
    const snaps = await engine.list(A, { service: "rds", type: "db-snapshot", region: R });
    expect(snaps.map((s) => s.name).sort()).toEqual(["app-db-final", "before-change"]);

    // The subnet group can't go while the copy still uses it.
    const group = (await engine.list(A, { service: "rds", type: "db-subnet-group", region: R }))[0];
    await expect(engine.remove(A, group.id)).rejects.toMatchObject({ code: "InvalidDBSubnetGroupStateFault" });
  });

  it("explains whether a server or the internet can connect", async () => {
    const n = await network();
    await create("rds", "db-subnet-group", { name: "app-db-subnets", description: "x", subnetIds: [n.privA.id, n.privB.id] });
    const db = await create("rds", "db-instance", base(n));
    const app = await create("compute", "instance", { imageId: "ami-0lab2023linux0001", subnetId: n.pub.id, securityGroupIds: [n.web.id] });
    const other = await create("networking", "security-group", { name: "other", description: "x", vpcId: n.vpc.id, inboundRules: [] });
    const stranger = await create("compute", "instance", { imageId: "ami-0lab2023linux0001", subnetId: n.pub.id, securityGroupIds: [other.id] });
    later(16_000);

    const fromApp = await analyzeDbConnection(engine, A, await engine.get(A, db.id), { from: app.id });
    expect(fromApp.reachable).toBe(true);
    expect(fromApp.command).toBe(`psql "host=${db.attributes.endpoint} port=5432 user=app dbname=postgres"`);

    const fromStranger = await analyzeDbConnection(engine, A, await engine.get(A, db.id), { from: stranger.id });
    expect(fromStranger.steps.find((s) => s.status === "fail")?.id).toBe("security-group");

    const fromInternet = await analyzeDbConnection(engine, A, await engine.get(A, db.id), {});
    expect(fromInternet.reachable).toBe(false);
    expect(fromInternet.steps.find((s) => s.id === "public-ip")?.status).toBe("fail");

    await engine.runAction(A, db.id, "stop");
    later(6_000);
    const stopped = await analyzeDbConnection(engine, A, await engine.get(A, db.id), { from: app.id });
    expect(stopped.steps[1]).toMatchObject({ id: "state", status: "fail" });
  });
});
