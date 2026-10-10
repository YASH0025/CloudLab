import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { EngineError } from "../errors";
import { MemoryStore } from "../store";
import { analyzeReachability, reachabilityInput } from "./reachability";

const ACCOUNT = "acct-test";
const REGION = "us-east-1";

let clock: Date;
let engine: Engine;

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof EngineError && e.code === code);
}

const create = (service: string, type: string, config: Record<string, unknown>) =>
  engine.create(ACCOUNT, { service, type, region: REGION, config });

const http = reachabilityInput.parse({ protocol: "tcp", port: 80 });
const ssh = reachabilityInput.parse({ protocol: "tcp", port: 22 });

/** Builds the classic public web server, optionally leaving pieces out. */
async function build(opts: { igw?: boolean; attach?: boolean; route?: boolean; associate?: boolean } = {}) {
  const { igw = true, attach = true, route = true, associate = true } = opts;
  const vpc = await create("networking", "vpc", { cidrBlock: "10.0.0.0/16" });
  const subnet = await create("networking", "subnet", {
    vpcId: vpc.id,
    cidrBlock: "10.0.1.0/24",
    availabilityZone: "us-east-1a",
    mapPublicIpOnLaunch: true,
  });
  const gateway = igw ? await create("networking", "internet-gateway", { vpcId: attach ? vpc.id : undefined }) : null;
  const table =
    gateway && attach
      ? await create("networking", "route-table", {
          vpcId: vpc.id,
          routes: route ? [{ destination: "0.0.0.0/0", gatewayId: gateway.id }] : [],
          subnetIds: associate ? [subnet.id] : [],
        })
      : null;
  const sg = await create("networking", "security-group", {
    name: "web",
    description: "web",
    vpcId: vpc.id,
    inboundRules: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0" }],
  });
  const instance = await create("compute", "instance", {
    imageId: "ami-0lab2023linux0001",
    subnetId: subnet.id,
    securityGroupIds: [sg.id],
  });
  advance(10_000);
  return { vpc, subnet, gateway, table, sg, instance };
}

const statusOf = (result: Awaited<ReturnType<typeof analyzeReachability>>, id: string) =>
  result.steps.find((s) => s.id === id)?.status;

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("reachability", () => {
  it("is reachable when every link in the chain is in place", async () => {
    const { instance } = await build();
    const result = await analyzeReachability(engine, ACCOUNT, instance.id, http);
    expect(result.reachable).toBe(true);
  });

  it("fails on the security group when the port is not allowed", async () => {
    const { instance } = await build();
    const result = await analyzeReachability(engine, ACCOUNT, instance.id, ssh);
    expect(result.reachable).toBe(false);
    expect(statusOf(result, "security-group")).toBe("fail");
    expect(statusOf(result, "route")).toBe("pass");
  });

  it("falls back to the VPC's main route table, which has no internet route", async () => {
    const { instance } = await build({ associate: false });
    const result = await analyzeReachability(engine, ACCOUNT, instance.id, http);
    expect(statusOf(result, "route-table")).toBe("pass");
    expect(result.steps.find((st) => st.id === "route-table")?.detail).toContain("main route table");
    expect(statusOf(result, "route")).toBe("fail");
  });

  it("is reachable through the main route table once it has an internet route", async () => {
    const { vpc, gateway, instance } = await build({ associate: false });
    const [main] = (await engine.list(ACCOUNT, { service: "networking", type: "route-table", region: REGION })).filter(
      (t) => t.config.vpcId === vpc.id && (t.attributes.system as { main?: boolean } | undefined)?.main,
    );
    await engine.update(ACCOUNT, main.id, { routes: [{ destination: "0.0.0.0/0", gatewayId: gateway!.id }] });
    expect((await analyzeReachability(engine, ACCOUNT, instance.id, http)).reachable).toBe(true);
  });

  it("fails when the route table has no internet route", async () => {
    const { instance } = await build({ route: false });
    const result = await analyzeReachability(engine, ACCOUNT, instance.id, http);
    expect(statusOf(result, "route")).toBe("fail");
  });

  it("fails when the instance is stopped", async () => {
    const { instance } = await build();
    await engine.runAction(ACCOUNT, instance.id, "stop");
    advance(5_000);
    const result = await analyzeReachability(engine, ACCOUNT, instance.id, http);
    expect(statusOf(result, "state")).toBe("fail");
  });
});

describe("internet gateways and route tables", () => {
  it("allows only one gateway per VPC", async () => {
    const { vpc } = await build();
    await expectCode(create("networking", "internet-gateway", { vpcId: vpc.id }), "Resource.AlreadyAssociated");
  });

  it("blocks detaching a gateway while instances have public IPs", async () => {
    const { gateway } = await build();
    await expectCode(engine.update(ACCOUNT, gateway!.id, { vpcId: null }), "DependencyViolation");
  });

  it("rejects routes to a gateway in another VPC", async () => {
    const { gateway } = await build();
    const other = await create("networking", "vpc", { cidrBlock: "10.9.0.0/16" });
    await expectCode(
      create("networking", "route-table", {
        vpcId: other.id,
        routes: [{ destination: "0.0.0.0/0", gatewayId: gateway!.id }],
      }),
      "InvalidParameterValue",
    );
  });

  it("rejects associating a subnet with two route tables", async () => {
    const { vpc, subnet } = await build();
    await expectCode(
      create("networking", "route-table", { vpcId: vpc.id, subnetIds: [subnet.id] }),
      "Resource.AlreadyAssociated",
    );
  });

  it("rejects a route that the local route already covers", async () => {
    const { vpc, gateway } = await build();
    await expectCode(
      create("networking", "route-table", {
        vpcId: vpc.id,
        routes: [{ destination: "10.0.5.0/24", gatewayId: gateway!.id }],
      }),
      "InvalidParameterValue",
    );
  });
});
