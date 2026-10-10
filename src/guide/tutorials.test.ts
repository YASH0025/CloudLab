import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { advanceProgress } from "./progress";
import { listTutorials, viewTutorial } from "./tutorials";

const ACCOUNT = "acct-tutorial";
const REGION = "us-east-1";

let clock: Date;
let engine: Engine;

const view = async (id: string) => (await viewTutorial(engine, ACCOUNT, REGION, id))!;
const tick = (ms = 10_000) => {
  clock = new Date(clock.getTime() + ms);
};

/**
 * Plays a tutorial the way a learner would: follow each step's pre-filled
 * "Take me there" form, or apply `manual` for steps that edit something.
 */
async function play(id: string, manual: Record<string, () => Promise<unknown>> = {}) {
  let progress = 0;
  for (let round = 0; round < 30; round++) {
    const t = await view(id);
    progress = advanceProgress(progress, t.steps.map((s) => s.passes));
    if (progress === t.steps.length) return progress;
    const step = t.steps[progress];
    if (manual[step.id]) await manual[step.id]();
    else if (step.link?.mode === "create") {
      await engine.create(ACCOUNT, { service: step.link.service, type: step.link.type, region: REGION, config: step.link.prefill ?? {} });
    }
    tick();
  }
  throw new Error(`tutorial ${id} did not finish (stuck at step ${progress})`);
}

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("progress", () => {
  it("only counts a step once all earlier steps are done", () => {
    expect(advanceProgress(0, [true, false, true])).toBe(1);
    expect(advanceProgress(1, [false, true, true])).toBe(3);
    expect(advanceProgress(5, [true])).toBe(1);
  });
});

describe("tutorials", () => {
  it("lists the catalogue", () => {
    expect(listTutorials().map((t) => t.id)).toEqual([
      "first-network",
      "first-web-server",
      "troubleshoot-reachability",
      "static-website",
      "private-network",
      "bastion-host",
      "web-and-database",
      "least-privilege",
      "managed-database",
      "highly-available-website",
    ]);
    expect(listTutorials().filter((t) => t.level === "intermediate")).toHaveLength(5);
    expect(listTutorials().find((t) => t.id === "troubleshoot-reachability")?.nextId).toBe("static-website");
  });

  it("completes 'Your first private network' by following its links", async () => {
    const done = await play("first-network", {
      "public-ip": async () => {
        const [subnet] = await engine.list(ACCOUNT, { service: "networking", type: "subnet", region: REGION });
        await engine.update(ACCOUNT, subnet.id, { mapPublicIpOnLaunch: true });
      },
    });
    expect(done).toBe(4);
  });

  it("completes 'A managed database for your web app': private, chained, backed up, Multi-AZ", async () => {
    await play("first-web-server");
    const steps = await play("managed-database", {
      // The learner types the password; everything else is pre-filled.
      database: async () => {
        const link = (await view("managed-database")).steps.find((x) => x.id === "database")!.link!;
        if (link.mode !== "create") return;
        await engine.create(ACCOUNT, { service: "rds", type: "db-instance", region: REGION, config: { ...link.prefill, masterUserPassword: "a-good-password" } });
      },
      connect: async () => undefined,
      "multi-az": async () => {
        const link = (await view("managed-database")).steps.find((x) => x.id === "multi-az")!.link!;
        const db = await engine.get(ACCOUNT, link.id!);
        if (!db.config.multiAZ) await engine.update(ACCOUNT, db.id, { multiAZ: true });
        else if (db.state === "available") await engine.runAction(ACCOUNT, db.id, "failover");
      },
    });
    expect(steps).toBe(8);
  });

  it("completes 'A website that never goes down': two zones, a load balancer, self-healing and scaling", async () => {
    await play("first-web-server");
    let stopped = false;
    const steps = await play("highly-available-website", {
      // Pre-filled: a subnet in the second zone. By hand: associate it with the public route table.
      "two-zones": async () => {
        const t = await view("highly-available-website");
        const link = t.steps[0].link!;
        if (link.mode === "create") {
          await engine.create(ACCOUNT, { service: link.service, type: link.type, region: REGION, config: link.prefill ?? {} });
        } else {
          const table = await engine.get(ACCOUNT, link.id!);
          const subnets = await engine.list(ACCOUNT, { service: "networking", type: "subnet", region: REGION });
          const extra = subnets.filter((x) => x.name === "public-b").map((x) => x.id);
          await engine.update(ACCOUNT, table.id, { subnetIds: [...((table.config.subnetIds as string[]) ?? []), ...extra] });
        }
      },
      "self-heal": async () => {
        if (stopped) return; // then just wait for the replacement
        stopped = true;
        const t = await view("highly-available-website");
        const id = t.steps.find((x) => x.id === "self-heal")!.link!.id!;
        await engine.runAction(ACCOUNT, id, "stop");
      },
      scale: async () => {
        const t = await view("highly-available-website");
        const id = t.steps.find((x) => x.id === "scale")!.link!.id!;
        await engine.update(ACCOUNT, id, { targetCpu: 50, simulatedTraffic: "spike" });
      },
    });
    expect(steps).toBe(10);
  });

  it("completes 'Launch your first web server' using only pre-filled forms", async () => {
    expect(await play("first-web-server")).toBe(7);
  });

  it("walks through breaking and fixing a server in order", async () => {
    await play("first-web-server");
    const id = "troubleshoot-reachability";
    const t0 = await view(id);
    // Working server: only step 1 passes; the "fix" steps also pass but must wait their turn.
    let progress = advanceProgress(0, t0.steps.map((s) => s.passes));
    expect(progress).toBe(1);

    const table = (await engine.list(ACCOUNT, { service: "networking", type: "route-table", region: REGION })).find(
      (t) => ((t.config.subnetIds as string[]) ?? []).length > 0,
    )!;
    const savedRoutes = table.config.routes;
    await engine.update(ACCOUNT, table.id, { routes: [] });
    progress = advanceProgress(progress, (await view(id)).steps.map((s) => s.passes));
    expect(progress).toBe(2);

    await engine.update(ACCOUNT, table.id, { routes: savedRoutes });
    progress = advanceProgress(progress, (await view(id)).steps.map((s) => s.passes));
    expect(progress).toBe(3);

    const group = (await engine.list(ACCOUNT, { service: "networking", type: "security-group", region: REGION })).find(
      (g) => g.name !== "default",
    )!;
    const savedRules = group.config.inboundRules;
    await engine.update(ACCOUNT, group.id, { inboundRules: [] });
    progress = advanceProgress(progress, (await view(id)).steps.map((s) => s.passes));
    expect(progress).toBe(4);

    await engine.update(ACCOUNT, group.id, { inboundRules: savedRules });
    progress = advanceProgress(progress, (await view(id)).steps.map((s) => s.passes));
    expect(progress).toBe(5);
  });

  it("completes the intermediate track in order, using pre-filled forms", async () => {
    expect(await play("private-network")).toBe(10);

    const bastionSteps = await play("bastion-host", {
      // The one hand edit: add a rule naming the bastion's group to the private server's group.
      "allow-from-bastion": async () => {
        const t = await view("bastion-host");
        const cli = t.steps.find((x) => x.id === "allow-from-bastion")!.cli!;
        const [, groupId, sourceId] = /--group-id (\S+) .* --source-group (\S+)/.exec(cli)!;
        const g = await engine.get(ACCOUNT, groupId);
        await engine.update(ACCOUNT, groupId, {
          inboundRules: [...((g.config.inboundRules as unknown[]) ?? []), { protocol: "tcp", fromPort: 22, toPort: 22, sourceGroupId: sourceId }],
        });
      },
    });
    expect(bastionSteps).toBe(6);

    expect(await play("web-and-database")).toBe(6);
    // The database is not reachable from the internet, but is from the web tier.
    const t = await view("web-and-database");
    expect(t.steps.every((x) => x.passes)).toBe(true);
  });

  it("doesn't pass the NAT step while the gateway sits in the private subnet", async () => {
    await play("private-network", {
      nat: async () => {
        const t = await view("private-network");
        const prefill = t.steps.find((x) => x.id === "nat")!.link!.prefill!;
        const subnets = await engine.list(ACCOUNT, { service: "networking", type: "subnet", region: REGION });
        const priv = subnets.find((x) => x.name === "private-a")!;
        await engine.create(ACCOUNT, { service: "networking", type: "nat-gateway", region: REGION, config: { ...prefill, subnetId: priv.id } });
        tick();
        const after = await view("private-network");
        expect(after.steps.find((x) => x.id === "nat")!.passes).toBe(false);
        throw new Error("stop");
      },
    }).catch((e) => expect((e as Error).message).toBe("stop"));
  });

  it("publishes a static website step by step", async () => {
    const t0 = await view("static-website");
    expect(t0.steps.map((x) => x.passes)).toEqual([false, false, false, false, false]);
    const done = await play("static-website", {
      upload: async () => {
        const bucket = (await engine.list(ACCOUNT, { service: "storage", type: "bucket" }))[0];
        await engine.objects.put(ACCOUNT, bucket.id, "index.html", Buffer.from("<h1>Hi</h1>"));
      },
      hosting: async () => {
        const bucket = (await engine.list(ACCOUNT, { service: "storage", type: "bucket" }))[0];
        await engine.update(ACCOUNT, bucket.id, { websiteEnabled: true, indexDocument: "index.html" });
      },
      public: async () => {
        const bucket = (await engine.list(ACCOUNT, { service: "storage", type: "bucket" }))[0];
        await engine.update(ACCOUNT, bucket.id, { blockPublicAccess: false, publicRead: true });
      },
    });
    expect(done).toBe(5);
  });

  it("teaches least privilege with IAM", async () => {
    const view2 = async (identity = "root") => (await viewTutorial(engine, ACCOUNT, REGION, "least-privilege", identity))!;
    const progress = async (identity?: string) => advanceProgress(0, (await view2(identity)).steps.map((s) => s.passes));
    const create = (type: string, config: Record<string, unknown>) => engine.create(ACCOUNT, { service: "iam", type, region: REGION, config });
    expect(await progress()).toBe(0);

    const t = await view2();
    await create("group", t.steps[0].link!.prefill!);
    await create("user", t.steps[1].link!.prefill!);
    expect(await progress()).toBe(2);
    expect(await progress("user/dev")).toBe(3);

    await engine.create(ACCOUNT, { service: "storage", type: "bucket", region: REGION, config: { name: "team-bucket-tut" } });
    const prefill = { ...t.steps[3].link!.prefill! };
    prefill.document = String(prefill.document).replaceAll("my-team-bucket", "team-bucket-tut");
    const policy = await create("policy", prefill);
    const group = (await engine.list(ACCOUNT, { service: "iam", type: "group", region: "global" }))[0];
    await engine.update(ACCOUNT, group.id, { policyArns: [...(group.config.policyArns as string[]), policy.attributes.arn] });
    expect(await progress("user/dev")).toBe(6);
  });
});
