import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { MemoryStore } from "../store";
import type { Resource } from "../types";
import { analyzeReachability } from "./reachability";

const A = "acct-vpcx";
const R = "us-east-1";
let clock: Date;
let engine: Engine;

const later = (ms = 10_000) => {
  clock = new Date(clock.getTime() + ms);
};
const create = (service: string, type: string, config: Record<string, unknown>) => engine.create(A, { service, type, region: R, config });
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected an error");
};
const step = (r: { steps: { id: string; status: string; detail: string }[] }, id: string) => r.steps.find((s) => s.id === id);

/** A VPC with one subnet (public if asked), a security group allowing the given port from `from`, and an instance. */
async function network(cidr: string, opts: { public?: boolean; port?: number; from?: string } = {}) {
  const base = cidr.split(".").slice(0, 2).join(".");
  const vpc = await create("networking", "vpc", { cidrBlock: cidr });
  const subnet = await create("networking", "subnet", { vpcId: vpc.id, cidrBlock: `${base}.1.0/24`, availabilityZone: "us-east-1a", mapPublicIpOnLaunch: !!opts.public });
  const table = await create("networking", "route-table", { vpcId: vpc.id, subnetIds: [subnet.id], routes: [] });
  if (opts.public) {
    const igw = await create("networking", "internet-gateway", { vpcId: vpc.id });
    await engine.update(A, table.id, { routes: [{ destination: "0.0.0.0/0", gatewayId: igw.id }] });
  }
  const sg = await create("networking", "security-group", {
    name: "sg",
    description: "sg",
    vpcId: vpc.id,
    inboundRules: [{ protocol: "tcp", fromPort: opts.port ?? 80, toPort: opts.port ?? 80, cidr: opts.from ?? "0.0.0.0/0" }],
    outboundRules: [{ protocol: "all", cidr: "0.0.0.0/0" }],
  });
  const instance = await create("compute", "instance", { imageId: "ami-0lab2023linux0001", subnetId: subnet.id, securityGroupIds: [sg.id] });
  later();
  return { vpc, subnet, table, sg, instance: await engine.get(A, instance.id) };
}

const http = { protocol: "tcp" as const, port: 80, source: "0.0.0.0/0" };

beforeEach(() => {
  clock = new Date("2026-10-01T10:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("network ACLs", () => {
  it("are stateless: a custom ACL needs a rule for the replies too", async () => {
    const { vpc, subnet, instance } = await network("10.0.0.0/16", { public: true });
    const acls = await engine.list(A, { service: "networking", type: "network-acl", region: R });
    expect(acls).toHaveLength(1);
    expect(await fails(engine.remove(A, acls[0].id))).toMatchObject({ message: `cannot delete default network ACL ${acls[0].id}` });
    expect((await analyzeReachability(engine, A, instance.id, http)).reachable).toBe(true);

    const acl = await create("networking", "network-acl", {
      name: "web",
      vpcId: vpc.id,
      inboundRules: [{ ruleNumber: 100, protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0", action: "allow" }],
      subnetIds: [subnet.id],
    });
    let r = await analyzeReachability(engine, A, instance.id, http);
    expect(r.reachable).toBe(false);
    expect(step(r, "nacl-in")?.status).toBe("pass");
    expect(step(r, "nacl-out")).toMatchObject({ status: "fail" });
    expect(step(r, "nacl-out")?.detail).toContain("stateless");

    await engine.update(A, acl.id, { outboundRules: [{ ruleNumber: 100, protocol: "tcp", fromPort: 1024, toPort: 65535, cidr: "0.0.0.0/0", action: "allow" }] });
    expect((await analyzeReachability(engine, A, instance.id, http)).reachable).toBe(true);

    // A lower-numbered deny wins, even though rule 100 allows.
    await engine.update(A, acl.id, {
      inboundRules: [
        { ruleNumber: 50, protocol: "all", cidr: "0.0.0.0/0", action: "deny" },
        { ruleNumber: 100, protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0", action: "allow" },
      ],
    });
    r = await analyzeReachability(engine, A, instance.id, http);
    expect(step(r, "nacl-in")?.detail).toContain("rule #50 (deny all traffic 0.0.0.0/0) matches first");

    expect(
      await fails(
        engine.update(A, acl.id, {
          inboundRules: [
            { ruleNumber: 100, protocol: "all", cidr: "0.0.0.0/0", action: "allow" },
            { ruleNumber: 100, protocol: "all", cidr: "0.0.0.0/0", action: "deny" },
          ],
        }),
      ),
    ).toMatchObject({ code: "NetworkAclEntryAlreadyExists" });
    expect(await fails(engine.remove(A, acl.id))).toMatchObject({ code: "DependencyViolation" });
  });
});

describe("VPC peering", () => {
  it("needs acceptance and a route on both sides, and isn't transitive", async () => {
    const app = await network("10.0.0.0/16", { port: 5432, from: "10.1.0.0/16" });
    const db = await network("10.1.0.0/16", { port: 5432, from: "10.0.0.0/16" });
    const pg = { protocol: "tcp" as const, port: 5432, from: app.instance.id, source: "0.0.0.0/0" };

    expect(await fails(create("networking", "peering-connection", { vpcId: app.vpc.id, peerVpcId: (await create("networking", "vpc", { cidrBlock: "10.0.0.0/16" })).id }))).toMatchObject({
      code: "InvalidParameterValue",
    });
    const pcx = await create("networking", "peering-connection", { vpcId: app.vpc.id, peerVpcId: db.vpc.id });
    expect(pcx.state).toBe("pending-acceptance");
    let r = await analyzeReachability(engine, A, db.instance.id, pg);
    expect(step(r, "same-vpc")?.detail).toContain("must accept it");

    await engine.runAction(A, pcx.id, "accept");
    later(3000);
    await engine.update(A, app.table.id, { routes: [{ destination: "10.1.0.0/16", vpcPeeringConnectionId: pcx.id }] });
    r = await analyzeReachability(engine, A, db.instance.id, pg);
    expect(step(r, "peering-route")?.status).toBe("pass");
    expect(step(r, "peering-route-back")).toMatchObject({ status: "fail" });
    expect(step(r, "peering-route-back")?.detail).toContain("both sides");

    await engine.update(A, db.table.id, { routes: [{ destination: "10.0.0.0/16", vpcPeeringConnectionId: pcx.id }] });
    expect((await analyzeReachability(engine, A, db.instance.id, pg)).reachable).toBe(true);

    // A third VPC peered with db only can't reach app through db.
    const third = await network("10.2.0.0/16", { port: 5432, from: "10.0.0.0/16" });
    const p2 = await create("networking", "peering-connection", { vpcId: db.vpc.id, peerVpcId: third.vpc.id });
    await engine.runAction(A, p2.id, "accept");
    later(3000);
    r = await analyzeReachability(engine, A, third.instance.id, pg);
    expect(step(r, "same-vpc")?.detail).toContain("isn't transitive");
  });
});

describe("VPC endpoints", () => {
  it("let a private server reach S3 without a NAT gateway", async () => {
    const { vpc, table, instance } = await network("10.0.0.0/16");
    const s3 = { protocol: "tcp" as const, port: 443, direction: "s3" as const, source: "0.0.0.0/0" };
    let r = await analyzeReachability(engine, A, instance.id, s3);
    expect(r.reachable).toBe(false);
    expect(step(r, "endpoint")?.status).toBe("info");

    const ep: Resource = await create("networking", "vpc-endpoint", { vpcId: vpc.id, service: "s3", routeTableIds: [table.id] });
    expect(ep.attributes).toMatchObject({ serviceName: "com.amazonaws.us-east-1.s3", prefixListId: "pl-63a5400a" });
    later(2000);
    r = await analyzeReachability(engine, A, instance.id, s3);
    expect(r.reachable).toBe(true);
    expect(r.summary).toContain(ep.id);
    expect(await fails(create("networking", "vpc-endpoint", { vpcId: vpc.id, service: "s3", routeTableIds: [table.id] }))).toMatchObject({ code: "RouteAlreadyExists" });
  });
});
