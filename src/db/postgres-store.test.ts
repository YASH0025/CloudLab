import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";
import { executeCli } from "@/cli/execute";
import { Engine } from "@/engine/engine";
import { EngineError } from "@/engine/errors";
import { PostgresStore } from "./postgres-store";

/**
 * Runs the engine on real Postgres (PGlite: Postgres compiled to run in-process),
 * using the same migration files as production. This covers the SQL the in-memory
 * store never exercises: array-contains lookups, JSONB round-trips, conflict
 * handling for claims, timestamps and region deletes.
 */

const REGION = "us-east-1";
let clock: Date;
let engine: Engine;
let store: PostgresStore;
let n = 0;
const account = () => `acct-pg-${++n}`;
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

beforeAll(async () => {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: "./drizzle" });
  store = new PostgresStore(db);
  clock = new Date("2026-01-01T00:00:00Z");
  engine = new Engine(store, () => clock);
}, 60_000);

describe("PostgresStore on real Postgres", () => {
  it("round-trips resources, JSONB config and timestamps, and settles lifecycles", async () => {
    const a = account();
    const vpc = await engine.create(a, { service: "networking", type: "vpc", region: REGION, config: { name: "main", cidrBlock: "10.0.0.0/16" } });
    const loaded = await store.get(a, vpc.id);
    expect(loaded).toMatchObject({ id: vpc.id, name: "main", state: "pending", pendingState: "available" });
    expect(loaded!.config).toEqual(vpc.config);
    expect(loaded!.createdAt).toBe(vpc.createdAt);
    advance(2_000);
    expect((await engine.get(a, vpc.id)).state).toBe("available");
    // The settled state was written back to the database.
    expect((await store.get(a, vpc.id))!.state).toBe("available");
  });

  it("keeps accounts apart", async () => {
    const a = account();
    const b = account();
    const vpc = await engine.create(a, { service: "networking", type: "vpc", region: REGION, config: { cidrBlock: "10.0.0.0/16" } });
    expect(await store.get(b, vpc.id)).toBeNull();
    expect(await store.list(b)).toHaveLength(0);
    await expect(engine.getTyped(b, vpc.id, "networking", "vpc")).rejects.toMatchObject({ code: "InvalidVpcID.NotFound" });
  });

  it("finds dependents through the refs array and cascades owned resources", async () => {
    const a = account();
    const vpc = await engine.create(a, { service: "networking", type: "vpc", region: REGION, config: { cidrBlock: "10.0.0.0/16" } });
    advance(2_000);
    const subnet = await engine.create(a, {
      service: "networking",
      type: "subnet",
      region: REGION,
      config: { vpcId: vpc.id, cidrBlock: "10.0.1.0/24", availabilityZone: "us-east-1a" },
    });
    // Main route table, default security group and the subnet all reference the VPC.
    expect((await store.findReferencing(a, vpc.id)).map((r) => r.type).sort()).toEqual(["route-table", "security-group", "subnet"]);
    await expect(engine.remove(a, vpc.id)).rejects.toSatisfy((e) => e instanceof EngineError && e.code === "DependencyViolation");
    await engine.remove(a, subnet.id);
    await engine.remove(a, vpc.id);
    expect(await store.list(a)).toHaveLength(0);
  });

  it("creates the default VPC exactly once, even when asked concurrently", async () => {
    const a = account();
    await Promise.all([engine.ensureDefaults(a, REGION), engine.ensureDefaults(a, REGION), engine.ensureDefaults(a, REGION)]);
    const vpcs = await engine.list(a, { service: "networking", type: "vpc", region: REGION });
    expect(vpcs).toHaveLength(1);
    expect(vpcs[0].config.cidrBlock).toBe("172.31.0.0/16");
    expect(await engine.list(a, { service: "networking", type: "subnet", region: REGION })).toHaveLength(3);
  });

  it("resets a region and lets the default VPC come back", async () => {
    const a = account();
    await engine.ensureDefaults(a, REGION);
    await engine.ensureDefaults(a, "eu-west-1");
    const removed = await engine.resetRegion(a, REGION);
    expect(removed).toBeGreaterThan(0);
    expect(await store.list(a, { region: REGION })).toHaveLength(0);
    expect((await store.list(a, { region: "eu-west-1" })).length).toBeGreaterThan(0);
    await engine.ensureDefaults(a, REGION);
    expect(await engine.defaultVpc(a, REGION)).toBeDefined();
  });

  it("enforces global bucket names across accounts", async () => {
    const a = account();
    const b = account();
    const name = `pg-bucket-${n}`;
    await engine.create(a, { service: "storage", type: "bucket", region: REGION, config: { name } });
    expect((await store.getAny(name))?.accountId).toBe(a);
    await expect(engine.create(b, { service: "storage", type: "bucket", region: REGION, config: { name } })).rejects.toMatchObject({
      code: "BucketAlreadyExists",
    });
  });

  it("runs a full web-server build through the CLI", async () => {
    const ctx = { engine, accountId: account(), region: REGION };
    const run = async (line: string) => {
      const r = await executeCli(line, ctx);
      if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
      return r.output ? JSON.parse(r.output) : {};
    };
    const vpc = (await run("aws ec2 create-vpc --cidr-block 10.0.0.0/16")).Vpc.VpcId;
    advance(2_000);
    const subnet = (await run(`aws ec2 create-subnet --vpc-id ${vpc} --cidr-block 10.0.1.0/24`)).Subnet.SubnetId;
    const igw = (await run("aws ec2 create-internet-gateway")).InternetGateway.InternetGatewayId;
    await run(`aws ec2 attach-internet-gateway --internet-gateway-id ${igw} --vpc-id ${vpc}`);
    const rt = (await run(`aws ec2 create-route-table --vpc-id ${vpc}`)).RouteTable.RouteTableId;
    await run(`aws ec2 create-route --route-table-id ${rt} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igw}`);
    await run(`aws ec2 associate-route-table --route-table-id ${rt} --subnet-id ${subnet}`);
    const sg = (await run(`aws ec2 create-security-group --group-name web --description web --vpc-id ${vpc}`)).GroupId;
    await run(`aws ec2 authorize-security-group-ingress --group-id ${sg} --protocol tcp --port 80 --cidr 0.0.0.0/0`);
    const inst = (
      await run(`aws ec2 run-instances --image-id ami-0lab2023linux0001 --subnet-id ${subnet} --security-group-ids ${sg} --associate-public-ip-address`)
    ).Instances[0];
    expect(inst.PrivateIpAddress).toBe("10.0.1.4");
    advance(10_000);
    const running = await run("aws ec2 describe-instances --filters Name=instance-state-name,Values=running");
    expect(running.Reservations).toHaveLength(1);
    const { analyzeReachability, reachabilityInput } = await import("@/engine/analysis/reachability");
    const reach = await analyzeReachability(engine, ctx.accountId, inst.InstanceId, reachabilityInput.parse({ protocol: "tcp", port: 80 }));
    expect(reach.reachable).toBe(true);
  });
});
