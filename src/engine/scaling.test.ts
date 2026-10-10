import { beforeEach, describe, expect, it } from "vitest";
import { targetHealth } from "./analysis/health";
import { testLoadBalancer } from "./analysis/loadtest";
import { Engine } from "./engine";
import { MemoryStore } from "./store";
import type { Resource } from "./types";

const A = "acct-scale";
const R = "us-east-1";
let clock: Date;
let engine: Engine;
const tick = async (ms = 0) => {
  clock = new Date(clock.getTime() + ms);
  await engine.ensureDefaults(A, R);
};
const create = (service: string, type: string, config: Record<string, unknown>) => engine.create(A, { service, type, region: R, config });
const instances = async () => (await engine.list(A, { service: "compute", type: "instance", region: R })).filter((i) => i.state !== "terminated" && i.state !== "shutting-down");

/** VPC with two public subnets in two zones, an internet gateway, and web + load balancer security groups. */
async function network() {
  const vpc = await create("networking", "vpc", { cidrBlock: "10.0.0.0/16" });
  clock = new Date(clock.getTime() + 2000);
  const a = await create("networking", "subnet", { vpcId: vpc.id, cidrBlock: "10.0.1.0/24", availabilityZone: "us-east-1a" });
  const b = await create("networking", "subnet", { vpcId: vpc.id, cidrBlock: "10.0.2.0/24", availabilityZone: "us-east-1b" });
  const igw = await create("networking", "internet-gateway", { vpcId: vpc.id });
  await create("networking", "route-table", { vpcId: vpc.id, routes: [{ destination: "0.0.0.0/0", gatewayId: igw.id }], subnetIds: [a.id, b.id] });
  const lbSg = await create("networking", "security-group", {
    name: "lb",
    description: "lb",
    vpcId: vpc.id,
    inboundRules: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0" }],
  });
  const webSg = await create("networking", "security-group", {
    name: "web",
    description: "web",
    vpcId: vpc.id,
    inboundRules: [{ protocol: "tcp", fromPort: 80, toPort: 80, sourceGroupId: lbSg.id }],
  });
  return { vpc, a, b, lbSg, webSg };
}

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("load balancing", () => {
  it("validates like ELB and reports target health with real reason codes", async () => {
    const n = await network();
    const tg = await create("loadbalancing", "target-group", { name: "web", port: 80, vpcId: n.vpc.id });
    expect(tg.id).toMatch(/^arn:aws:elasticloadbalancing:us-east-1:\d{12}:targetgroup\/web\/[0-9a-f]{16}$/);
    await expect(
      create("loadbalancing", "load-balancer", { name: "lb", subnetIds: [n.a.id], securityGroupIds: [n.lbSg.id] }),
    ).rejects.toMatchObject({ code: "ValidationError", message: "At least two subnets in two different Availability Zones must be specified" });

    const lb = await create("loadbalancing", "load-balancer", {
      name: "lb",
      subnetIds: [n.a.id, n.b.id],
      securityGroupIds: [n.lbSg.id],
      listeners: [{ protocol: "HTTP", port: 80, targetGroupId: tg.id }],
    });
    expect(lb.attributes.dnsName).toMatch(/^lb-\d+\.us-east-1\.elb\.cloudlab\.local$/);
    expect(lb.state).toBe("provisioning");

    const good = await create("compute", "instance", { imageId: "ami-0lab2023linux0001", subnetId: n.a.id, securityGroupIds: [n.webSg.id] });
    const shut = await create("networking", "security-group", { name: "shut", description: "no inbound", vpcId: n.vpc.id, inboundRules: [] });
    const closed = await create("compute", "instance", { imageId: "ami-0lab2023linux0001", subnetId: n.b.id, securityGroupIds: [shut.id] });
    await engine.update(A, tg.id, { targets: [good.id, closed.id] });
    const health = async () => {
      const t = await engine.get(A, tg.id);
      return Object.fromEntries((await targetHealth(engine, A, t, clock)).map((h) => [h.id, `${h.state}:${h.reason ?? ""}`]));
    };
    expect(await health()).toEqual({ [good.id]: "initial:Elb.RegistrationInProgress", [closed.id]: "initial:Elb.RegistrationInProgress" });
    clock = new Date(clock.getTime() + 15_000);
    // The second instance's group doesn't let the load balancer in on port 80.
    expect(await health()).toEqual({ [good.id]: "healthy:", [closed.id]: "unhealthy:Target.Timeout" });
    await engine.runAction(A, good.id, "stop");
    clock = new Date(clock.getTime() + 10_000);
    expect((await health())[good.id]).toBe("unused:Target.InvalidState");

    await expect(engine.remove(A, tg.id)).rejects.toMatchObject({ code: "ResourceInUse" });
  });
});

describe("auto scaling", () => {
  async function group(extra: Record<string, unknown> = {}) {
    const n = await network();
    const tg = await create("loadbalancing", "target-group", { name: "web", port: 80, vpcId: n.vpc.id });
    await create("loadbalancing", "load-balancer", {
      name: "lb",
      subnetIds: [n.a.id, n.b.id],
      securityGroupIds: [n.lbSg.id],
      listeners: [{ protocol: "HTTP", port: 80, targetGroupId: tg.id }],
    });
    await create("compute", "launch-template", { name: "web-lt", imageId: "ami-0lab2023linux0001", instanceType: "t3.micro", securityGroupIds: [n.webSg.id] });
    const asg = await create("autoscaling", "auto-scaling-group", {
      name: "web-asg",
      launchTemplate: "web-lt",
      subnetIds: [n.a.id, n.b.id],
      minSize: 1,
      desiredCapacity: 2,
      maxSize: 4,
      targetGroupIds: [tg.id],
      ...extra,
    });
    return { n, tg, asg };
  }

  it("launches across zones, registers targets and replaces failed instances", async () => {
    const { tg, asg } = await group();
    await tick();
    const launched = await instances();
    expect(launched).toHaveLength(2);
    expect(new Set(launched.map((i) => i.attributes.availabilityZone))).toEqual(new Set(["us-east-1a", "us-east-1b"]));
    expect(((await engine.get(A, tg.id)).config.targets as string[]).sort()).toEqual(launched.map((i) => i.id).sort());

    // Stop one: the group terminates it and launches a replacement.
    await tick(10_000);
    await engine.runAction(A, launched[0].id, "stop");
    await tick(10_000);
    await tick(1_000);
    const now = await instances();
    expect(now).toHaveLength(2);
    expect(now.map((i) => i.id)).not.toContain(launched[0].id);
    const activities = (await engine.get(A, asg.id)).attributes.activities as { description: string; cause: string }[];
    expect(activities.some((a) => a.cause.includes("EC2 instance status check failure"))).toBe(true);
    expect(((await engine.get(A, tg.id)).config.targets as string[])).not.toContain(launched[0].id);
  });

  it("scales out and back in with target tracking on simulated traffic", async () => {
    const { asg } = await group({ targetCpu: 50, simulatedTraffic: "normal" });
    await tick();
    await tick(10_000);
    expect(await instances()).toHaveLength(2);

    await engine.update(A, asg.id, { simulatedTraffic: "spike" });
    await tick(1_000);
    expect((await engine.get(A, asg.id)).config.desiredCapacity).toBe(4);
    expect(await instances()).toHaveLength(4);

    await engine.update(A, asg.id, { simulatedTraffic: "idle" });
    await tick(10_000); // instances become running
    await tick(1_000); // still inside the scale-in cooldown
    expect((await engine.get(A, asg.id)).config.desiredCapacity).toBe(4);
    await tick(25_000);
    expect((await engine.get(A, asg.id)).config.desiredCapacity).toBe(1);
    await tick(1_000);
    expect((await instances()).filter((i) => i.state !== "shutting-down")).toHaveLength(1);
  });

  it("won't delete a group with instances unless forced", async () => {
    const { asg } = await group();
    await tick();
    await expect(engine.remove(A, asg.id)).rejects.toMatchObject({ code: "ResourceInUse" });
    await engine.remove(A, asg.id, { force: true });
    const left = (await engine.list(A, { service: "compute", type: "instance", region: R })) as Resource[];
    expect(left.every((i) => i.state === "shutting-down" || i.state === "terminated")).toBe(true);
  });
});

describe("sending requests to a load balancer", () => {
  it("fails like a real ALB, then round-robins across healthy targets", async () => {
    const n = await network();
    const tg = await create("loadbalancing", "target-group", { name: "web", port: 80, vpcId: n.vpc.id });
    const closedLbSg = await create("networking", "security-group", { name: "closed", description: "x", vpcId: n.vpc.id, inboundRules: [] });
    const lb = await create("loadbalancing", "load-balancer", {
      name: "lb",
      subnetIds: [n.a.id, n.b.id],
      securityGroupIds: [closedLbSg.id],
      listeners: [{ protocol: "HTTP", port: 80, targetGroupId: tg.id }],
    });
    const send = async () => testLoadBalancer(engine, A, await engine.get(A, lb.id), { count: 4 });

    expect((await send()).responses[0].statusText).toMatch(/Could not resolve host/);
    clock = new Date(clock.getTime() + 7_000);
    expect((await send()).steps.at(-1)).toMatchObject({ id: "sg", status: "fail" });

    await engine.update(A, lb.id, { securityGroupIds: [n.lbSg.id] });
    let r = await send();
    expect(r.responses.map((x) => x.status)).toEqual([503, 503, 503, 503]);

    // Targets that never answer: the load balancer fails open and times out.
    const shut = await create("networking", "security-group", { name: "shut", description: "x", vpcId: n.vpc.id, inboundRules: [] });
    const bad = await create("compute", "instance", { imageId: "ami-0lab2023linux0001", subnetId: n.a.id, securityGroupIds: [shut.id] });
    await engine.update(A, tg.id, { targets: [bad.id] });
    clock = new Date(clock.getTime() + 15_000);
    r = await send();
    expect(r.responses.map((x) => x.status)).toEqual([504, 504, 504, 504]);

    const a = await create("compute", "instance", { imageId: "ami-0lab2023linux0001", subnetId: n.a.id, securityGroupIds: [n.webSg.id] });
    const b = await create("compute", "instance", { imageId: "ami-0lab2023linux0001", subnetId: n.b.id, securityGroupIds: [n.webSg.id] });
    await engine.update(A, tg.id, { targets: [bad.id, a.id, b.id] });
    clock = new Date(clock.getTime() + 15_000);
    r = await send();
    expect(r.ok).toBe(true);
    expect(r.responses.map((x) => x.targetId)).toEqual([a.id, b.id, a.id, b.id]);
    expect(r.steps.at(-1)?.detail).toContain("2 of 3");
  });
});
