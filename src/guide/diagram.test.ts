import { describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { buildDiagram } from "./diagram";

describe("network diagram", () => {
  it("draws VPCs by zone, with each subnet's kind and what runs in it", async () => {
    let clock = new Date("2026-10-01T10:00:00Z");
    const engine = new Engine(new MemoryStore(), () => clock);
    const A = "acct-diagram";
    const R = "us-east-1";
    const make = (service: string, type: string, config: Record<string, unknown>) => engine.create(A, { service, type, region: R, config });
    const vpc = await make("networking", "vpc", { name: "main", cidrBlock: "10.0.0.0/16" });
    const pub = await make("networking", "subnet", { name: "public-a", vpcId: vpc.id, cidrBlock: "10.0.1.0/24", availabilityZone: "us-east-1a", mapPublicIpOnLaunch: true });
    const priv = await make("networking", "subnet", { name: "private-b", vpcId: vpc.id, cidrBlock: "10.0.2.0/24", availabilityZone: "us-east-1b" });
    const igw = await make("networking", "internet-gateway", { vpcId: vpc.id });
    await make("networking", "route-table", { vpcId: vpc.id, routes: [{ destination: "0.0.0.0/0", gatewayId: igw.id }], subnetIds: [pub.id] });
    const sg = await make("networking", "security-group", { name: "web", description: "web", vpcId: vpc.id });
    await make("compute", "instance", { name: "web-1", imageId: "ami-0lab2023linux0001", subnetId: pub.id, securityGroupIds: [sg.id] });
    clock = new Date(clock.getTime() + 10_000);

    const d = await buildDiagram(engine, A, R);
    const main = d.vpcs.find((v) => v.id === vpc.id)!;
    expect(main.internetGateway?.id).toBe(igw.id);
    expect(main.zones.map((z) => z.name)).toEqual(["us-east-1a", "us-east-1b"]);
    const [a] = main.zones[0].subnets;
    expect(a).toMatchObject({ name: "public-a", kind: "public", route: `0.0.0.0/0 → ${igw.id}` });
    expect(a.nodes[0]).toMatchObject({ name: "web-1", type: "instance", state: "running", tags: ["web"] });
    expect(main.zones[1].subnets[0]).toMatchObject({ id: priv.id, kind: "isolated", nodes: [] });
  });
});
