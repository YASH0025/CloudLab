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
