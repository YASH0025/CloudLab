import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { advise } from "./advisor";
import { explainError } from "./errors";

const ACCOUNT = "acct-guide";
const REGION = "us-east-1";

let clock: Date;
let engine: Engine;

const next = async () => (await advise(engine, ACCOUNT, REGION)).next;

/** Follows the suggestion the way a learner would: submit the pre-filled create form. */
async function follow() {
  const s = await next();
  const link = s.link!;
  expect(link.mode).toBe("create");
  return engine.create(ACCOUNT, { service: link.service, type: link.type, region: REGION, config: link.prefill ?? {} });
}

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("advisor", () => {
  it("walks a beginner from nothing to a reachable web server", async () => {
    expect((await next()).id).toBe("create-vpc");
    await follow();
    expect((await next()).id).toBe("wait-vpc");
    clock = new Date(clock.getTime() + 2_000);

    expect((await next()).id).toBe("create-subnet");
    await follow();
    expect((await next()).id).toBe("create-sg");
    await follow();
    expect((await next()).id).toBe("launch-instance");
    await follow();
    expect((await next()).id).toBe("wait-instance");
    clock = new Date(clock.getTime() + 10_000);

    expect((await next()).id).toBe("create-igw");
    await follow();
    expect((await next()).id).toBe("create-rt");
    await follow();

    const advice = await advise(engine, ACCOUNT, REGION);
    expect(advice.milestones.find((m) => m.id === "reachable")?.done).toBe(true);
    expect(advice.next.id).toBe("create-bucket");
    await follow();

    const after = await advise(engine, ACCOUNT, REGION);
    expect(after.next.id).toBe("check-reachability");
    expect(after.milestones.every((m) => m.done)).toBe(true);
    expect(after.level).not.toBe("beginner");
  });

  it("points at the security group when only the firewall is missing", async () => {
    const vpc = await engine.create(ACCOUNT, { service: "networking", type: "vpc", region: REGION, config: { cidrBlock: "10.0.0.0/16" } });
    clock = new Date(clock.getTime() + 2_000);
    const subnet = await engine.create(ACCOUNT, {
      service: "networking",
      type: "subnet",
      region: REGION,
      config: { vpcId: vpc.id, cidrBlock: "10.0.1.0/24", availabilityZone: "us-east-1a" },
    });
    const igw = await engine.create(ACCOUNT, { service: "networking", type: "internet-gateway", region: REGION, config: { vpcId: vpc.id } });
    await engine.create(ACCOUNT, {
      service: "networking",
      type: "route-table",
      region: REGION,
      config: { vpcId: vpc.id, routes: [{ destination: "0.0.0.0/0", gatewayId: igw.id }], subnetIds: [subnet.id] },
    });
    const sg = await engine.create(ACCOUNT, {
      service: "networking",
      type: "security-group",
      region: REGION,
      config: { name: "closed", description: "no rules", vpcId: vpc.id },
    });
    await engine.create(ACCOUNT, {
      service: "compute",
      type: "instance",
      region: REGION,
      config: { imageId: "ami-0lab2023linux0001", subnetId: subnet.id, securityGroupIds: [sg.id], associatePublicIp: "enable" },
    });
    clock = new Date(clock.getTime() + 10_000);
    const s = await next();
    expect(s.id).toBe("allow-http");
    expect(s.cli).toContain(`--group-id ${sg.id}`);
  });

  it("suggests an Elastic IP when a server in a public setup has no public IP", async () => {
    const vpc = await engine.create(ACCOUNT, { service: "networking", type: "vpc", region: REGION, config: { cidrBlock: "10.0.0.0/16" } });
    clock = new Date(clock.getTime() + 2_000);
    const subnet = await engine.create(ACCOUNT, {
      service: "networking",
      type: "subnet",
      region: REGION,
      config: { vpcId: vpc.id, cidrBlock: "10.0.1.0/24", availabilityZone: "us-east-1a" },
    });
    await engine.create(ACCOUNT, { service: "networking", type: "internet-gateway", region: REGION, config: { vpcId: vpc.id } });
    const sg = await engine.create(ACCOUNT, {
      service: "networking",
      type: "security-group",
      region: REGION,
      config: { name: "web", description: "web", vpcId: vpc.id },
    });
    const instance = await engine.create(ACCOUNT, {
      service: "compute",
      type: "instance",
      region: REGION,
      config: { imageId: "ami-0lab2023linux0001", subnetId: subnet.id, securityGroupIds: [sg.id], associatePublicIp: "disable" },
    });
    clock = new Date(clock.getTime() + 10_000);
    const s = await next();
    expect(s.id).toBe("needs-public-ip");
    expect(s.cli).toBe("aws ec2 allocate-address");
    const eip = await follow();
    expect(eip.type).toBe("elastic-ip");
    const inst = await engine.get(ACCOUNT, instance.id);
    expect(inst.attributes.publicIp).toBe(eip.attributes.publicIp);
    expect((await next()).id).not.toBe("needs-public-ip");
  });

  it("flags a database port open to the internet and an idle Elastic IP", async () => {
    const vpc = await engine.create(ACCOUNT, { service: "networking", type: "vpc", region: REGION, config: { cidrBlock: "10.0.0.0/16" } });
    clock = new Date(clock.getTime() + 2_000);
    const g = await engine.create(ACCOUNT, {
      service: "networking",
      type: "security-group",
      region: REGION,
      config: { name: "db", description: "db", vpcId: vpc.id, inboundRules: [{ protocol: "tcp", fromPort: 5432, toPort: 5432, cidr: "0.0.0.0/0" }] },
    });
    const eip = await engine.create(ACCOUNT, { service: "compute", type: "elastic-ip", region: REGION, config: {} });
    const advice = await advise(engine, ACCOUNT, REGION);
    const ids = [advice.next, ...advice.more].map((x) => x.id);
    expect(ids).toContain(`db-open-${g.id}`);
    expect(ids).toContain(`unused-eip-${eip.id}`);
  });

  it("explains common error codes", () => {
    expect(explainError("DependencyViolation")?.fix).toMatch(/Used by/);
    expect(explainError("InvalidVpcID.NotFound")?.meaning).toMatch(/doesn't exist/);
    expect(explainError("SomethingElse")).toBeUndefined();
  });
});

describe("advisor: load balancing", () => {
  it("puts a load balancer that can't reach its servers first, and explains ELB errors", async () => {
    await engine.ensureDefaults(ACCOUNT, REGION);
    const [vpc] = await engine.list(ACCOUNT, { service: "networking", type: "vpc", region: REGION });
    const subnets = (await engine.list(ACCOUNT, { service: "networking", type: "subnet", region: REGION })).sort((a, b) =>
      String(a.config.availabilityZone).localeCompare(String(b.config.availabilityZone)),
    );
    const create = (service: string, type: string, config: Record<string, unknown>) => engine.create(ACCOUNT, { service, type, region: REGION, config });
    const lbSg = await create("networking", "security-group", {
      name: "lb",
      description: "lb",
      vpcId: vpc.id,
      inboundRules: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0" }],
    });
    const shut = await create("networking", "security-group", { name: "shut", description: "x", vpcId: vpc.id, inboundRules: [] });
    const tg = await create("loadbalancing", "target-group", { name: "web", port: 80, vpcId: vpc.id });
    await create("loadbalancing", "load-balancer", {
      name: "lb",
      subnetIds: [subnets[0].id, subnets[1].id],
      securityGroupIds: [lbSg.id],
      listeners: [{ protocol: "HTTP", port: 80, targetGroupId: tg.id }],
    });
    const inst = await create("compute", "instance", { imageId: "ami-0lab2023linux0001", subnetId: subnets[0].id, securityGroupIds: [shut.id] });
    await engine.update(ACCOUNT, tg.id, { targets: [inst.id] });
    clock = new Date(clock.getTime() + 20_000);

    const s = await next();
    expect(s.id).toBe(`tg-timeout-${tg.id}`);
    expect(s.steps.join(" ")).toContain(lbSg.id);
    expect(explainError("ResourceInUse")?.fix).toContain("--force-delete");
    expect(explainError("DuplicateListener")).toBeDefined();
  });
});

describe("advisor: databases", () => {
  it("flags a database open to the internet before anything else", async () => {
    await engine.ensureDefaults(ACCOUNT, REGION);
    const [vpc] = await engine.list(ACCOUNT, { service: "networking", type: "vpc", region: REGION });
    const subnets = await engine.list(ACCOUNT, { service: "networking", type: "subnet", region: REGION });
    const create = (service: string, type: string, config: Record<string, unknown>) => engine.create(ACCOUNT, { service, type, region: REGION, config });
    const open = await create("networking", "security-group", {
      name: "open-db",
      description: "x",
      vpcId: vpc.id,
      inboundRules: [{ protocol: "tcp", fromPort: 5432, toPort: 5432, cidr: "0.0.0.0/0" }],
    });
    await create("rds", "db-subnet-group", { name: "pub", description: "x", subnetIds: subnets.map((x) => x.id) });
    const db = await create("rds", "db-instance", {
      name: "leaky",
      engine: "postgres",
      dbInstanceClass: "db.t3.micro",
      allocatedStorage: 20,
      masterUsername: "app",
      masterUserPassword: "password123",
      dbSubnetGroupName: "pub",
      vpcSecurityGroupIds: [open.id],
      publiclyAccessible: true,
      backupRetentionPeriod: 0,
    });
    const advice = await advise(engine, ACCOUNT, REGION);
    expect(advice.next.id).toBe(`db-open-${db.id}`);
    expect(explainError("DBSubnetGroupDoesNotCoverEnoughAZs")?.fix).toContain("another");
  });
});

describe("advisor: serverless", () => {
  it("points at the missing permission when an API returns 500", { timeout: 30_000 }, async () => {
    const { handleApiRequest } = await import("@/engine/apigw/handle");
    const create = (service: string, type: string, config: Record<string, unknown>, region = REGION) => engine.create(ACCOUNT, { service, type, region, config });
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
    await create("iam", "role", { name: "r", trustPolicy: trust }, "global");
    const fn = await create("lambda", "function", { name: "hello", role: "r" });
    clock = new Date(clock.getTime() + 2_000);
    const api = await create("apigateway", "api", { name: "hello-api" });
    await create("apigateway", "stage", { apiId: api.id, name: "$default" });
    const integ = await create("apigateway", "integration", { apiId: api.id, functionName: "hello" });
    await create("apigateway", "route", { apiId: api.id, routeKey: "$default", integrationId: integ.id });
    await handleApiRequest(engine, { apiId: api.id, method: "GET", path: "/", query: "", headers: {}, body: "", sourceIp: "198.51.100.1" });
    const s = await next();
    expect(s.id).toBe(`api-permission-${api.id}`);
    expect(s.link).toMatchObject({ service: "lambda", id: fn.id });
  });
});

describe("advisor: monitoring", () => {
  it("flags lost Lambda logs, then an alarm that is going off", { timeout: 30_000 }, async () => {
    const { invokeFunction } = await import("@/engine/lambda/invoke");
    const create = (service: string, type: string, config: Record<string, unknown>, region = REGION) => engine.create(ACCOUNT, { service, type, region, config });
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
    await create("iam", "role", { name: "r", trustPolicy: trust }, "global");
    const fn = await create("lambda", "function", { name: "orders", role: "r", files: { "index.mjs": "export const handler = async () => { throw new Error('no'); };" } });
    clock = new Date(clock.getTime() + 2_000);
    const a = await advise(engine, ACCOUNT, REGION);
    expect([a.next, ...a.more].map((x) => x.id)).toContain("watch-your-app");
    await invokeFunction(engine, ACCOUNT, await engine.get(ACCOUNT, fn.id), {}, "console");
    let s = await next();
    expect(s.id).toBe(`fn-logs-denied-${fn.id}`);
    expect(s.cli).toContain("attach-role-policy --role-name r ");

    const role = (await engine.list(ACCOUNT, { service: "iam", type: "role", region: "global" }))[0];
    await engine.update(ACCOUNT, role.id, { policyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"] });
    await create("cloudwatch", "alarm", {
      name: "orders-errors",
      namespace: "AWS/Lambda",
      metricName: "Errors",
      dimensions: [{ name: "FunctionName", value: "orders" }],
      statistic: "Sum",
      period: 60,
      evaluationPeriods: 1,
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      treatMissingData: "notBreaching",
    });
    await invokeFunction(engine, ACCOUNT, await engine.get(ACCOUNT, fn.id), {}, "console");
    clock = new Date(clock.getTime() + 60_000);
    await engine.ensureDefaults(ACCOUNT, REGION); // alarms are checked whenever the region is looked at
    s = await next();
    expect(s.id).toMatch(/^alarm-firing-arn:aws:cloudwatch:us-east-1:\d{12}:alarm:orders-errors$/);
    expect(s.why).toMatch(/^Errors > 0 for 1 of 1 × 1 min is true right now\. Threshold Crossed/);
    expect(explainError("InvalidParameterInput")?.fix).toContain("Add to dashboard");
  });
});

describe("advisor: Route 53", () => {
  it("flags a record pointing at an IP no server has, and a failing health check", { timeout: 30_000 }, async () => {
    const zone = await engine.create(ACCOUNT, { service: "route53", type: "hosted-zone", region: "global", config: { name: "myshop.com" } });
    expect((await advise(engine, ACCOUNT, REGION)).more.map((s) => s.id).concat((await next()).id)).toContain(`dns-empty-zone-${zone.id}`);
    const www = await engine.create(ACCOUNT, {
      service: "route53",
      type: "record-set",
      region: "global",
      config: { zoneId: zone.id, name: "www", type: "A", ttl: 300, values: [{ value: "203.0.113.77" }], routingPolicy: "simple" },
    });
    const s = await next();
    expect(s.id).toBe(`dns-stale-ip-${www.id}`);
    expect(s.steps[1]).toContain("Elastic IP");
    await engine.create(ACCOUNT, { service: "route53", type: "health-check", region: "global", config: { type: "HTTP", ipAddress: "203.0.113.77", port: 80 } });
    const ids = [(await next()).id, ...(await advise(engine, ACCOUNT, REGION)).more.map((x) => x.id)];
    expect(ids.some((id) => id.startsWith("health-check-failing-"))).toBe(true);
    expect(explainError("InvalidChangeBatch")?.fix).toContain("Alias");
  });
});

describe("advisor: EBS", () => {
  it("points out unattached volumes", async () => {
    const vol = await engine.create(ACCOUNT, { service: "compute", type: "volume", region: REGION, config: { name: "old-data", availabilityZone: "us-east-1a", size: 50, volumeType: "gp3" } });
    clock = new Date(clock.getTime() + 5_000);
    const a = await advise(engine, ACCOUNT, REGION);
    expect([a.next, ...a.more].map((s) => s.id)).toContain(`volume-unattached-${vol.id}`);
    expect(explainError("InvalidVolume.ZoneMismatch")?.fix).toContain("Snapshot");
  });
});
