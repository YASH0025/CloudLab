import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { MemoryStore } from "../store";
import { healthCheckStatus, request, resolve } from "./dns";

const ACCOUNT = "acct-r53";
const REGION = "us-east-1";
let clock: Date;
let engine: Engine;

const create = (service: string, type: string, config: Record<string, unknown>, region = REGION) => engine.create(ACCOUNT, { service, type, region, config });
const zone = (name = "myshop.com") => create("route53", "hosted-zone", { name }, "global");
const record = (config: Record<string, unknown>) => create("route53", "record-set", { routingPolicy: "simple", ttl: 300, ...config }, "global");
const records = async () => engine.list(ACCOUNT, { service: "route53", type: "record-set", region: "global" });
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected an error");
};

async function webServer() {
  const vpc = await create("networking", "vpc", { cidrBlock: "10.0.0.0/16" });
  const subnet = await create("networking", "subnet", { vpcId: vpc.id, cidrBlock: "10.0.1.0/24", availabilityZone: "us-east-1a", mapPublicIpOnLaunch: true });
  const igw = await create("networking", "internet-gateway", { vpcId: vpc.id });
  await create("networking", "route-table", { vpcId: vpc.id, routes: [{ destination: "0.0.0.0/0", gatewayId: igw.id }], subnetIds: [subnet.id] });
  const sg = await create("networking", "security-group", { name: "web", description: "web", vpcId: vpc.id, inboundRules: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0" }] });
  const instance = await create("compute", "instance", { imageId: "ami-0lab2023linux0001", subnetId: subnet.id, securityGroupIds: [sg.id] });
  clock = new Date(clock.getTime() + 10_000);
  return { sg, instance: await engine.get(ACCOUNT, instance.id) };
}

beforeEach(() => {
  clock = new Date("2026-10-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("hosted zones", () => {
  it("start with NS and SOA records, and can't be deleted while they hold your records", async () => {
    const z = await zone("MyShop.com.");
    expect(z.name).toBe("myshop.com");
    expect(z.id).toMatch(/^Z0[A-Z0-9]{19}$/);
    const all = await records();
    expect(all.map((r) => r.config.type).sort()).toEqual(["NS", "SOA"]);
    expect((await engine.get(ACCOUNT, z.id)).attributes.recordCount).toBe(2);

    expect(await fails(zone("example.com"))).toMatchObject({ code: "InvalidDomainName", message: "example.com is reserved by AWS!" });
    expect(await fails(zone("bad_domain!.com"))).toMatchObject({ code: "InvalidDomainName" });

    const ns = all.find((r) => r.config.type === "NS")!;
    expect(await fails(engine.remove(ACCOUNT, ns.id))).toMatchObject({ message: "[A HostedZone must contain at least one NS record for the zone itself.]" });

    const www = await record({ zoneId: z.id, name: "www", type: "A", values: [{ value: "203.0.113.10" }] });
    expect(www.name).toBe("www.myshop.com");
    expect(await fails(engine.remove(ACCOUNT, z.id))).toMatchObject({ code: "HostedZoneNotEmpty" });
    await engine.remove(ACCOUNT, www.id);
    await engine.remove(ACCOUNT, z.id);
    expect(await records()).toEqual([]);
  });
});

describe("records", () => {
  it("rejects what Route 53 rejects, with its messages", async () => {
    const z = await zone();
    await record({ zoneId: z.id, name: "www", type: "A", values: [{ value: "203.0.113.10" }] });
    expect(await fails(record({ zoneId: z.id, name: "www", type: "A", values: [{ value: "203.0.113.11" }] }))).toMatchObject({
      code: "InvalidChangeBatch",
      message: "[Tried to create resource record set [name='www.myshop.com.', type='A'] but it already exists]",
    });
    expect(await fails(record({ zoneId: z.id, name: "", type: "CNAME", values: [{ value: "www.myshop.com" }] }))).toMatchObject({
      message: "[RRSet of type CNAME with DNS name myshop.com. is not permitted at apex in zone myshop.com.]",
    });
    expect(await fails(record({ zoneId: z.id, name: "www", type: "CNAME", values: [{ value: "other.myshop.com" }] }))).toMatchObject({
      message: "[RRSet of type CNAME with DNS name www.myshop.com. is not permitted as it conflicts with other records with the same DNS name in zone myshop.com.]",
    });
    expect(await fails(record({ zoneId: z.id, name: "api", type: "A", values: [{ value: "300.1.1.1" }] }))).toMatchObject({
      message: "[Invalid Resource Record: 'FATAL problem: ARRDATAIllegalIPv4Address (Value is not a valid IPv4 address) encountered with '300.1.1.1'']",
    });
    expect(await fails(record({ zoneId: z.id, name: "www.other.com.", type: "A", values: [{ value: "203.0.113.1" }] }))).toMatchObject({
      message: "[RRSet with DNS name www.other.com. is not permitted in zone myshop.com.]",
    });
    expect(await fails(record({ zoneId: z.id, name: "txt", type: "TXT", values: [{ value: "hello" }] }))).toMatchObject({
      message: "[Invalid Resource Record: 'FATAL problem: InvalidCharacterString (Value should be enclosed in quotation marks) encountered with 'hello'']",
    });
    expect(await fails(record({ zoneId: z.id, name: "", type: "A", alias: true, aliasTarget: "nope.elb.cloudlab.local" }))).toMatchObject({
      message: `[Tried to create an alias that targets nope.elb.cloudlab.local., type A in zone ${z.id}, but the alias target name does not lie within the target zone]`,
    });
    expect(await fails(record({ zoneId: z.id, name: "www", type: "A", routingPolicy: "weighted", setIdentifier: "blue", weight: 50, values: [{ value: "203.0.113.12" }] }))).toMatchObject({
      message: "[RRSet with DNS name www.myshop.com., type A, SetIdentifier blue cannot be created as a non-weighted set exists with the same name and type.]",
    });
  });

  it("resolves A records, CNAMEs, aliases and wildcards like a real resolver", async () => {
    const z = await zone();
    await record({ zoneId: z.id, name: "www", type: "A", values: [{ value: "203.0.113.10" }] });
    await record({ zoneId: z.id, name: "shop", type: "CNAME", values: [{ value: "www.myshop.com" }] });
    await record({ zoneId: z.id, name: "", type: "A", alias: true, aliasTarget: "www.myshop.com." });
    await record({ zoneId: z.id, name: "*.apps", type: "A", values: [{ value: "203.0.113.20" }] });

    expect((await resolve(engine, ACCOUNT, "www.myshop.com")).answers).toEqual([{ name: "www.myshop.com", type: "A", ttl: 300, value: "203.0.113.10" }]);
    const viaCname = await resolve(engine, ACCOUNT, "shop.myshop.com");
    expect(viaCname.answers.map((a) => `${a.type} ${a.value}`)).toEqual(["CNAME www.myshop.com.", "A 203.0.113.10"]);
    // The apex alias answers with an A record directly, no CNAME.
    expect((await resolve(engine, ACCOUNT, "myshop.com")).answers).toEqual([{ name: "myshop.com", type: "A", ttl: 60, value: "203.0.113.10" }]);
    expect((await resolve(engine, ACCOUNT, "x.apps.myshop.com")).answers[0].value).toBe("203.0.113.20");
    const missing = await resolve(engine, ACCOUNT, "nope.myshop.com");
    expect(missing).toMatchObject({ status: "NXDOMAIN", authority: [{ type: "SOA" }] });
    expect((await resolve(engine, ACCOUNT, "www.myshop.com", "MX")).answers).toEqual([]);
    expect((await resolve(engine, ACCOUNT, "google.com")).status).toBe("NXDOMAIN");
  });

  it("shares traffic by weight", async () => {
    const z = await zone();
    await record({ zoneId: z.id, name: "www", type: "A", routingPolicy: "weighted", setIdentifier: "blue", weight: 90, values: [{ value: "203.0.113.1" }] });
    await record({ zoneId: z.id, name: "www", type: "A", routingPolicy: "weighted", setIdentifier: "green", weight: 10, values: [{ value: "203.0.113.2" }] });
    expect((await resolve(engine, ACCOUNT, "www.myshop.com", "A", { random: () => 0.5 })).answers[0].value).toBe("203.0.113.1");
    expect((await resolve(engine, ACCOUNT, "www.myshop.com", "A", { random: () => 0.95 })).answers[0].value).toBe("203.0.113.2");
  });
});

describe("web requests and health checks", { timeout: 30_000 }, () => {
  it("reaches a web server by name, and fails over when it stops answering", async () => {
    const { instance, sg } = await webServer();
    const ip = String(instance.attributes.publicIp);
    const z = await zone();
    const hc = await create("route53", "health-check", { type: "HTTP", ipAddress: ip, port: 80, resourcePath: "/" }, "global");
    expect(await healthCheckStatus(engine, ACCOUNT, hc)).toMatchObject({ healthy: true, report: "Success: HTTP Status Code 200, OK" });

    await record({ zoneId: z.id, name: "www", type: "A", routingPolicy: "failover", setIdentifier: "main", failover: "PRIMARY", healthCheckId: hc.id, values: [{ value: ip }] });
    await record({ zoneId: z.id, name: "www", type: "A", routingPolicy: "failover", setIdentifier: "backup", failover: "SECONDARY", values: [{ value: "203.0.113.99" }] });

    const ok = await request(engine, ACCOUNT, "http://www.myshop.com/");
    expect(ok).toMatchObject({ kind: "response", status: 200 });
    expect(ok.kind === "response" && ok.body).toContain(`Hello from ${instance.id}`);
    expect((await engine.get(ACCOUNT, z.id)).attributes.recentRequests).toMatchObject([{ host: "www.myshop.com", status: 200 }]);

    // Close port 80: the health check fails and Route 53 answers with the secondary.
    await engine.update(ACCOUNT, sg.id, { inboundRules: [] });
    expect((await healthCheckStatus(engine, ACCOUNT, hc)).healthy).toBe(false);
    expect((await resolve(engine, ACCOUNT, "www.myshop.com")).answers[0].value).toBe("203.0.113.99");
    expect(await request(engine, ACCOUNT, "http://www.myshop.com/")).toMatchObject({ kind: "error", exitCode: 28 });

    expect(await fails(engine.remove(ACCOUNT, hc.id))).toMatchObject({ code: "HealthCheckInUse" });
    expect(await fails(create("route53", "health-check", { type: "HTTP", ipAddress: "10.0.1.5", port: 80 }, "global"))).toMatchObject({ code: "InvalidInput" });
  });
});
