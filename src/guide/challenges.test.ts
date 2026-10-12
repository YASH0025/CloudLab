import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { addPermission, removePermission } from "@/engine/lambda/invoke";
import { MemoryStore } from "@/engine/store";
import type { Resource } from "@/engine/types";
import { challengeScore, listChallenges, startChallenge, viewChallenge } from "./challenges";

const ACCOUNT = "acct-lab~challenge";
const R = "us-east-1";
let clock: Date;
let engine: Engine;

const find = async (service: string, type: string, name: string, region = R) =>
  (await engine.list(ACCOUNT, { service, type, region })).find((r) => r.name === name) as Resource;
const view = (id: string, hints = 0) => viewChallenge(engine, ACCOUNT, id, hints).then((v) => v!);

async function play(id: string, fix: () => Promise<void>, wrongFix?: { apply: () => Promise<void>; status: RegExp }) {
  expect(await startChallenge(engine, ACCOUNT, id)).toBe(true);
  clock = new Date(clock.getTime() + 15_000);
  const before = await view(id, 1);
  expect(before.solved).toBe(false);
  expect(before.hints).toHaveLength(1);
  expect(before.explanation).toBeUndefined();
  if (wrongFix) {
    await wrongFix.apply();
    expect((await view(id)).status).toMatch(wrongFix.status);
  }
  await fix();
  clock = new Date(clock.getTime() + 15_000);
  const after = await view(id);
  expect(after.status).toBeUndefined();
  expect(after.solved).toBe(true);
  expect(after.explanation).toBeTruthy();
}

const rules = (g: Resource) => g.config.inboundRules as Record<string, unknown>[];

beforeEach(() => {
  clock = new Date("2026-10-01T10:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("challenges", { timeout: 60_000 }, () => {
  it("lists them, and scores fewer points per hint", () => {
    expect(listChallenges().map((c) => c.id)).toEqual(["site-down", "no-updates", "access-denied", "db-connect", "api-500", "disk-wrong-zone", "peering-one-way", "acl-replies", "silent-orders", "unhealthy-targets"]);
    expect([0, 1, 2, 3].map(challengeScore)).toEqual([100, 90, 70, 40]);
  });

  it("silent-orders: fix the filter's case and let only this topic invoke the function", async () => {
    const sub = async () => (await engine.list(ACCOUNT, { service: "sns", type: "subscription", region: R }))[0];
    const fn = () => find("lambda", "function", "fulfil");
    const topic = () => find("sns", "topic", "orders");
    await play(
      "silent-orders",
      async () => {
        await engine.update(ACCOUNT, (await sub()).id, { filterPolicy: '{"type":["order"]}' });
        expect((await view("silent-orders")).status).toMatch(/every delivery to the function fails/);
        await addPermission(engine, ACCOUNT, await fn(), { statementId: "sns", action: "lambda:InvokeFunction", principal: "sns.amazonaws.com", sourceArn: (await topic()).id });
      },
      {
        apply: async () => engine.update(ACCOUNT, (await sub()).id, { filterPolicy: "" }).then(() => undefined),
        status: /so do refunds/,
      },
    );
  });

  it("site-down: open port 80 to the internet, and only port 80", async () => {
    const sg = () => find("networking", "security-group", "web-sg");
    await play(
      "site-down",
      async () => {
        await engine.update(ACCOUNT, (await sg()).id, { inboundRules: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0" }] });
      },
      {
        apply: async () => engine.update(ACCOUNT, (await sg()).id, { inboundRules: [{ protocol: "all", cidr: "0.0.0.0/0" }] }).then(() => undefined),
        status: /open on \(almost\) every port/,
      },
    );
    expect((await view("site-down")).facts[0]).toMatch(/^Shop address: http:\/\/203\.0\.113\.\d+$/);
  });

  it("no-updates: route the private subnet through the NAT gateway", async () => {
    await play("no-updates", async () => {
      const rt = await find("networking", "route-table", "private-rt");
      const nat = await find("networking", "nat-gateway", "shop-nat");
      await engine.update(ACCOUNT, rt.id, { routes: [{ destination: "0.0.0.0/0", natGatewayId: nat.id }] });
    });
  });

  it("access-denied: GetObject needs the objects' ARN, not the bucket's", async () => {
    const policy = () => find("iam", "policy", "reports-read", "global");
    const bucket = async () => (await engine.list(ACCOUNT, { service: "storage", type: "bucket", region: R }))[0].id;
    const doc = (getResource: string, extra: string[] = []) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "s3:ListBucket", Resource: `arn:aws:s3:::BUCKET`.replace("BUCKET", "*") },
          { Effect: "Allow", Action: ["s3:GetObject", ...extra], Resource: getResource },
        ],
      });
    await play(
      "access-denied",
      async () => {
        await engine.update(ACCOUNT, (await policy()).id, { document: doc(`arn:aws:s3:::${await bucket()}/*`) });
      },
      {
        apply: async () => engine.update(ACCOUNT, (await policy()).id, { document: doc("*", ["s3:*"]) }).then(() => undefined),
        status: /also has s3:PutObject/,
      },
    );
  });

  it("db-connect: PostgreSQL listens on 5432, not 3306", async () => {
    await play("db-connect", async () => {
      const db = await find("networking", "security-group", "db-sg");
      const web = await find("networking", "security-group", "web-sg");
      await engine.update(ACCOUNT, db.id, { inboundRules: [{ protocol: "tcp", fromPort: 5432, toPort: 5432, sourceGroupId: web.id }] });
    });
  });

  it("api-500: the function's permission names the old API", async () => {
    const fn = () => find("lambda", "function", "orders");
    await play(
      "api-500",
      async () => {
        const api = await find("apigateway", "api", "shop-api");
        await removePermission(engine, ACCOUNT, await fn(), "anyone");
        await addPermission(engine, ACCOUNT, await fn(), {
          statementId: "shop-api",
          action: "lambda:InvokeFunction",
          principal: "apigateway.amazonaws.com",
          sourceArn: `arn:aws:execute-api:${R}:${String((await fn()).id.split(":")[4])}:${api.id}/*`,
        });
      },
      {
        apply: async () => {
          await addPermission(engine, ACCOUNT, await fn(), { statementId: "anyone", action: "lambda:InvokeFunction", principal: "apigateway.amazonaws.com" });
        },
        status: /any API Gateway API may invoke/,
      },
    );
  });

  it("disk-wrong-zone: restore the snapshot in the instance's zone", async () => {
    await play("disk-wrong-zone", async () => {
      const app = await find("compute", "instance", "shop-app");
      const wrong = await find("compute", "volume", "reports-restore");
      await expect(engine.update(ACCOUNT, wrong.id, { instanceId: app.id, device: "/dev/sdf" })).rejects.toMatchObject({ code: "InvalidVolume.ZoneMismatch" });
      const snap = await find("compute", "snapshot", "reports-nightly");
      await engine.create(ACCOUNT, { service: "compute", type: "volume", region: R, config: { snapshotId: snap.id, availabilityZone: "us-east-1a", volumeType: "gp3", instanceId: app.id, device: "/dev/sdf" } });
      // Creating (2 s), then attaching (1.5 s): each step settles when the volume is next looked at.
      clock = new Date(clock.getTime() + 3_000);
      await engine.list(ACCOUNT, { service: "compute", type: "volume", region: R });
    });
  });

  it("peering-one-way: the reply needs a route back", async () => {
    await play("peering-one-way", async () => {
      const rt = await find("networking", "route-table", "data-vpc-rt");
      const pcx = await find("networking", "peering-connection", "app-to-data");
      await engine.update(ACCOUNT, rt.id, { routes: [{ destination: "10.0.0.0/16", vpcPeeringConnectionId: pcx.id }] });
    });
  });

  it("acl-replies: network ACLs are stateless", async () => {
    const acl = () => find("networking", "network-acl", "web-acl");
    await play(
      "acl-replies",
      async () => {
        const a = await acl();
        await engine.update(ACCOUNT, a.id, {
          inboundRules: (a.config.inboundRules as unknown[]).filter((r) => (r as { protocol: string }).protocol !== "all"),
          outboundRules: [...(a.config.outboundRules as unknown[]), { ruleNumber: 120, protocol: "tcp", fromPort: 1024, toPort: 65535, cidr: "0.0.0.0/0", action: "allow" }],
        });
      },
      {
        apply: async () => {
          const a = await acl();
          await engine.update(ACCOUNT, a.id, { inboundRules: [...(a.config.inboundRules as unknown[]), { ruleNumber: 200, protocol: "all", cidr: "0.0.0.0/0", action: "allow" }] });
        },
        status: /allows all inbound/,
      },
    );
  });

  it("unhealthy-targets: allow HTTP from the load balancer's group", async () => {
    await play("unhealthy-targets", async () => {
      const web = await find("networking", "security-group", "web-sg");
      const alb = await find("networking", "security-group", "alb-sg");
      await engine.update(ACCOUNT, web.id, { inboundRules: [...rules(web).filter((r) => r.fromPort !== 80), { protocol: "tcp", fromPort: 80, toPort: 80, sourceGroupId: alb.id }] });
    });
  });

  it("starts each challenge from a clean account", async () => {
    await startChallenge(engine, ACCOUNT, "site-down");
    await startChallenge(engine, ACCOUNT, "site-down");
    expect((await engine.list(ACCOUNT, { service: "compute", type: "instance", region: R })).filter((i) => i.name === "shop-web")).toHaveLength(1);
    expect(await startChallenge(engine, ACCOUNT, "nope")).toBe(false);
  });
});
