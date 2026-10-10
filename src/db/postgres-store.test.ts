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

  it("moves an anonymous lab into an empty account, claims included", async () => {
    const anon = account();
    const user = account();
    await engine.ensureDefaults(anon, REGION);
    const count = (await store.list(anon)).length;
    expect(await engine.adoptLab(anon, user)).toBe(count);
    expect(await store.list(anon)).toHaveLength(0);
    await engine.ensureDefaults(user, REGION);
    expect(await engine.list(user, { service: "networking", type: "vpc", region: REGION })).toHaveLength(1);
    // A second anonymous lab doesn't overwrite the user's.
    const anon2 = account();
    await engine.ensureDefaults(anon2, REGION);
    expect(await engine.adoptLab(anon2, user)).toBe(0);
  });

  it("keeps an Elastic IP on its instance through stop and start, and never stores private keys", async () => {
    const ctx = { engine, accountId: account(), region: REGION };
    const run = async (line: string) => {
      const r = await executeCli(line, ctx);
      if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
      return r.output ? JSON.parse(r.output) : {};
    };
    const key = await run("aws ec2 create-key-pair --key-name pg-key");
    expect(key.KeyMaterial).toContain("PRIVATE KEY");
    expect((await store.get(ctx.accountId, key.KeyPairId))!.attributes).not.toHaveProperty("keyMaterial");

    const id = (await run("aws ec2 run-instances --image-id ami-0lab2023linux0001 --key-name pg-key")).Instances[0].InstanceId;
    advance(10_000);
    const eip = await run("aws ec2 allocate-address");
    await run(`aws ec2 associate-address --instance-id ${id} --allocation-id ${eip.AllocationId}`);
    await run(`aws ec2 stop-instances --instance-ids ${id}`);
    advance(10_000);
    await run(`aws ec2 start-instances --instance-ids ${id}`);
    advance(10_000);
    const inst = (await run(`aws ec2 describe-instances --instance-ids ${id}`)).Reservations[0].Instances[0];
    expect(inst).toMatchObject({ PublicIpAddress: eip.PublicIp, KeyName: "pg-key", State: { Name: "running" } });
  });

  it("stores objects' bytes apart, replaces on put, and cleans up on reset and sign-in", async () => {
    const a = account();
    const name = `pg-objects-${n}`;
    await engine.create(a, { service: "storage", type: "bucket", region: REGION, config: { name } });
    await engine.objects.put(a, name, "index.html", Buffer.from("<h1>v1</h1>"));
    await engine.objects.put(a, name, "index.html", Buffer.from("<h1>v2</h1>"));
    await engine.objects.put(a, name, "img/logo.png", Buffer.from([0, 1, 2, 255]));
    expect((await engine.objects.get(a, name, "index.html")).data.toString()).toBe("<h1>v2</h1>");
    expect([...(await engine.objects.get(a, name, "img/logo.png")).data]).toEqual([0, 1, 2, 255]);
    expect(await engine.objects.list(a, name, { delimiter: "/" })).toMatchObject({ prefixes: ["img/"], objects: [{ key: "index.html", size: 11 }] });
    await expect(engine.remove(a, name)).rejects.toMatchObject({ code: "BucketNotEmpty" });

    // Signing in moves the files with the lab.
    const user = account();
    await engine.adoptLab(a, user);
    expect((await engine.objects.get(user, name, "index.html")).data.toString()).toBe("<h1>v2</h1>");
    await expect(engine.objects.get(a, name, "index.html")).rejects.toMatchObject({ code: "NoSuchBucket" });

    // Resetting the region removes objects and their bytes.
    const id = (await store.list(user, { service: "storage", type: "object" }))[0].id;
    await engine.resetRegion(user, REGION);
    expect(await store.getBlob(user, id)).toBeNull();
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

  it("runs load balancing and Auto Scaling: ARN ids, locks, launches and self-healing", async () => {
    const ctx = { engine, accountId: account(), region: REGION };
    const run = async (line: string) => {
      const r = await executeCli(line, ctx);
      if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
      return r.output ? JSON.parse(r.output) : {};
    };
    const vpc = (await run("aws ec2 describe-vpcs")).Vpcs[0].VpcId;
    const subnets = (await run(`aws ec2 describe-subnets --filters Name=vpc-id,Values=${vpc}`)).Subnets.sort(
      (a: { AvailabilityZone: string }, b: { AvailabilityZone: string }) => a.AvailabilityZone.localeCompare(b.AvailabilityZone),
    );
    const sg = (await run(`aws ec2 describe-security-groups --filters Name=vpc-id,Values=${vpc} Name=group-name,Values=default`)).SecurityGroups[0].GroupId;
    const tg = (await run(`aws elbv2 create-target-group --name web --protocol HTTP --port 80 --vpc-id ${vpc}`)).TargetGroups[0].TargetGroupArn;
    const lb = (await run(`aws elbv2 create-load-balancer --name web-lb --subnets ${subnets[0].SubnetId} ${subnets[1].SubnetId} --security-groups ${sg}`))
      .LoadBalancers[0].LoadBalancerArn;
    await run(`aws elbv2 create-listener --load-balancer-arn ${lb} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tg}`);
    await run(`aws ec2 create-launch-template --launch-template-name web --launch-template-data '{"ImageId":"ami-0lab2023linux0001","SecurityGroupIds":["${sg}"]}'`);
    await run(
      `aws autoscaling create-auto-scaling-group --auto-scaling-group-name web-asg --launch-template LaunchTemplateName=web --min-size 2 --max-size 4 --vpc-zone-identifier ${subnets[0].SubnetId},${subnets[1].SubnetId} --target-group-arns ${tg}`,
    );
    advance(15_000);
    await run("aws autoscaling describe-auto-scaling-groups");
    advance(15_000);
    const health = (await run(`aws elbv2 describe-target-health --target-group-arn ${tg}`)).TargetHealthDescriptions;
    expect(health.map((h: { TargetHealth: { State: string } }) => h.TargetHealth.State)).toEqual(["healthy", "healthy"]);

    const victim = health[0].Target.Id;
    await run(`aws ec2 stop-instances --instance-ids ${victim}`);
    advance(10_000);
    await run("aws autoscaling describe-auto-scaling-groups");
    advance(11_000);
    const group = (await run("aws autoscaling describe-auto-scaling-groups")).AutoScalingGroups[0];
    expect(group.Instances).toHaveLength(2);
    expect(group.Instances.map((i: { InstanceId: string }) => i.InstanceId)).not.toContain(victim);

    await run("aws autoscaling delete-auto-scaling-group --auto-scaling-group-name web-asg --force-delete");
    await run(`aws elbv2 delete-load-balancer --load-balancer-arn ${lb}`);
    await run(`aws elbv2 delete-target-group --target-group-arn ${tg}`);
  });
});
