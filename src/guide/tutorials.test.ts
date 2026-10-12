import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { advanceProgress } from "./progress";
import { listTutorials, viewTutorial } from "./tutorials";
import { handleApiRequest } from "@/engine/apigw/handle";
import { addPermission, invokeFunction } from "@/engine/lambda/invoke";

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
      "serverless-api",
      "watch-your-app",
      "get-alerted",
      "decouple-with-a-queue",
      "nosql-table",
      "managed-database",
      "website-real-name",
      "disks-and-backups",
      "highly-available-website",
      "connect-and-protect",
      "infrastructure-as-code",
    ]);
    expect(listTutorials().filter((t) => t.level === "intermediate")).toHaveLength(12);
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

  it("completes 'Your first serverless API', including the 500 before add-permission", { timeout: 60_000 }, async () => {
    const id = "serverless-api";
    const link = async (step: string) => (await view(id)).steps.find((x) => x.id === step)!.link!;
    const fnOf = async () => (await engine.list(ACCOUNT, { service: "lambda", type: "function", region: REGION }))[0];
    const apiOf = async () => (await engine.list(ACCOUNT, { service: "apigateway", type: "api", region: REGION }))[0];
    const call = async () => handleApiRequest(engine, { apiId: (await apiOf()).id, method: "GET", path: "/hello", query: "name=Ada", headers: {}, body: "", sourceIp: "198.51.100.1" });
    const steps = await play(id, {
      test: async () => {
        await invokeFunction(engine, ACCOUNT, await fnOf(), { queryStringParameters: { name: "Test" } }, "console");
      },
      "first-call": async () => {
        expect((await call()).status).toBe(500);
      },
      permission: async () => {
        const fn = await fnOf();
        const l = await link("permission");
        expect(l.id).toBe(fn.id);
        await addPermission(engine, ACCOUNT, fn, { statementId: "apigw", action: "lambda:InvokeFunction", principal: "apigateway.amazonaws.com" });
      },
      success: async () => {
        const res = await call();
        expect(res.body).toBe('{"message":"Hello, Ada!"}');
      },
    });
    expect(steps).toBe(10);
  });

  it("completes 'Watch your app': logs, graphs, an alarm that fires, a dashboard", { timeout: 60_000 }, async () => {
    const id = "watch-your-app";
    const fnOf = async () => (await engine.list(ACCOUNT, { service: "lambda", type: "function", region: REGION })).find((f) => f.name === "orders")!;
    const steps = await play(id, {
      run: async () => {
        await invokeFunction(engine, ACCOUNT, await fnOf(), { item: "book" }, "console");
        await invokeFunction(engine, ACCOUNT, await fnOf(), {}, "console");
      },
      // Reading steps: nothing to do, their checks pass from what's already there.
      logs: async () => undefined,
      graphs: async () => undefined,
      fire: async () => {
        await invokeFunction(engine, ACCOUNT, await fnOf(), {}, "console");
        tick(60_000);
      },
    });
    expect(steps).toBe(8);
    const t = await view(id);
    expect(t.steps.find((s) => s.id === "fire")!.link).toMatchObject({ service: "cloudwatch", type: "alarm", mode: "detail" });
  });

  it("completes 'Get alerted': a topic, a confirmed email, an alarm that emails, a filter policy", { timeout: 60_000 }, async () => {
    const { confirmSubscription, publish } = await import("@/engine/sns/publish");
    const list = (service: string, type: string) => engine.list(ACCOUNT, { service, type, region: REGION });
    const fnOf = async () => (await list("lambda", "function")).find((f) => f.name === "orders")!;
    const topicOf = async () => (await list("sns", "topic"))[0];
    const confirmAll = async () => {
      for (const s of await list("sns", "subscription")) if (s.state !== "confirmed") await confirmSubscription(engine, ACCOUNT, await topicOf(), String(s.attributes.token));
    };
    await play("watch-your-app", {
      run: async () => {
        await invokeFunction(engine, ACCOUNT, await fnOf(), { item: "book" }, "console");
        await invokeFunction(engine, ACCOUNT, await fnOf(), {}, "console");
      },
      logs: async () => undefined,
      graphs: async () => undefined,
      fire: async () => {
        await invokeFunction(engine, ACCOUNT, await fnOf(), {}, "console");
        tick(60_000);
      },
    });
    const steps = await play("get-alerted", {
      confirm: confirmAll,
      publish: async () => publish(engine, ACCOUNT, await topicOf(), { message: "Hello", subject: "Test" }),
      "alarm-action": async () => {
        const t = await view("get-alerted");
        const link = t.steps.find((s) => s.id === "alarm-action")!.link!;
        expect(link).toMatchObject({ service: "cloudwatch", type: "alarm", mode: "detail" });
        await engine.update(ACCOUNT, link.id!, { alarmActions: [(await topicOf()).id] });
      },
      fire: async () => {
        // Back to OK after a quiet minute, then a bad order sets it off again.
        tick(120_000);
        await view("get-alerted");
        await invokeFunction(engine, ACCOUNT, await fnOf(), {}, "console");
        tick(60_000);
      },
      filter: async () => {
        if (!(await list("sns", "subscription")).some((s) => s.config.filterPolicy)) {
          const link = (await view("get-alerted")).steps.find((s) => s.id === "filter")!.link!;
          await engine.create(ACCOUNT, { service: "sns", type: "subscription", region: REGION, config: link.prefill! });
        }
        await confirmAll();
        for (const severity of ["critical", "low"]) {
          await publish(engine, ACCOUNT, await topicOf(), { message: "x", attributes: { severity: { DataType: "String", StringValue: severity } } });
        }
      },
    });
    expect(steps).toBe(7);
  });

  it("completes 'Never lose an order': send, receive, a message that comes back, a dead-letter queue, fan-out", { timeout: 60_000 }, async () => {
    const q = await import("@/engine/sqs/queue");
    const { publish } = await import("@/engine/sns/publish");
    const list = (service: string, type: string) => engine.list(ACCOUNT, { service, type, region: REGION });
    const queueOf = async () => (await list("sqs", "queue")).find((x) => x.name === "orders-queue")!;
    let handle = "";
    const steps = await play("decouple-with-a-queue", {
      send: async () => q.sendMessage(engine, await queueOf(), { body: '{"orderId":1}' }),
      receive: async () => {
        handle = (await q.receiveMessages(engine, await queueOf())).messages[0].ReceiptHandle;
      },
      "comes-back": async () => {
        tick(21_000);
        handle = (await q.receiveMessages(engine, await queueOf())).messages[0].ReceiptHandle;
      },
      delete: async () => q.deleteMessage(engine, await queueOf(), handle),
      dlq: async () => {
        const link = (await view("decouple-with-a-queue")).steps.find((s) => s.id === "dlq")!.link!;
        if (link.mode === "create") await engine.create(ACCOUNT, { service: "sqs", type: "queue", region: REGION, config: link.prefill! });
        else {
          const dlq = (await list("sqs", "queue")).find((x) => x.name === "orders-dlq")!;
          await engine.update(ACCOUNT, (await queueOf()).id, { deadLetterQueue: dlq.id, maxReceiveCount: 3 });
        }
      },
      "fan-out": async () => {
        let topic = (await list("sns", "topic"))[0];
        if (!topic) {
          topic = await engine.create(ACCOUNT, { service: "sns", type: "topic", region: REGION, config: { name: "alerts" } });
          return;
        }
        const queue = await queueOf();
        await engine.update(ACCOUNT, queue.id, { policy: q.withStatement(queue, q.snsSendStatement(queue, topic.id)) });
        await engine.create(ACCOUNT, { service: "sns", type: "subscription", region: REGION, config: { topicArn: topic.id, protocol: "sqs", endpoint: String(queue.attributes.arn) } });
        await publish(engine, ACCOUNT, topic, { message: "order placed" });
      },
    });
    expect(steps).toBe(7);
  });

  it("completes 'Design a NoSQL table': items, query, scan, an index, a conditional write", { timeout: 60_000 }, async () => {
    const d = await import("@/engine/dynamodb/items");
    const { marshallItem } = await import("@/engine/dynamodb/values");
    const tableOf = async () => (await engine.list(ACCOUNT, { service: "dynamodb", type: "table", region: REGION }))[0];
    const steps = await play("nosql-table", {
      items: async () => {
        for (const [c, date, status] of [["asha", "2026-10-01", "placed"], ["asha", "2026-10-05", "shipped"], ["ravi", "2026-10-02", "placed"]]) {
          await d.putItem(engine, await tableOf(), marshallItem({ customerId: c, orderDate: date, status, total: 10 }));
        }
      },
      query: async () => d.query(engine, await tableOf(), { keyCondition: "customerId = :c", values: { ":c": { S: "asha" } } }),
      scan: async () => d.scan(engine, await tableOf()),
      index: async () =>
        engine.update(ACCOUNT, (await tableOf()).id, { globalSecondaryIndexes: [{ indexName: "by-status", partitionKey: "status", partitionKeyType: "S", sortKey: "orderDate", sortKeyType: "S" }] }),
      "query-index": async () => {
        const r = await d.query(engine, await tableOf(), { indexName: "by-status", keyCondition: "#s = :s", names: { "#s": "status" }, values: { ":s": { S: "placed" } } });
        expect(r.Count).toBe(2);
      },
      condition: async () => {
        await expect(
          d.putItem(engine, await tableOf(), marshallItem({ customerId: "asha", orderDate: "2026-10-01" }), { condition: "attribute_not_exists(customerId)" }),
        ).rejects.toThrow("The conditional request failed");
      },
    });
    expect(steps).toBe(7);
  });

  it("completes 'Infrastructure as code': create, update in place, replace, roll back, delete", { timeout: 60_000 }, async () => {
    const stackOf = async () => (await engine.list(ACCOUNT, { service: "cloudformation", type: "stack", region: REGION }))[0];
    const steps = await play("infrastructure-as-code", {
      explore: async () => undefined,
      update: async () => {
        const s = await stackOf();
        await engine.update(ACCOUNT, s.id, { templateBody: String(s.config.templateBody).replace("VisibilityTimeout: 60", "VisibilityTimeout: 120") });
      },
      replace: async () => engine.update(ACCOUNT, (await stackOf()).id, { parameters: [{ key: "Env", value: "prod" }] }),
      rollback: async () => {
        const s = await stackOf();
        await engine.update(ACCOUNT, s.id, { templateBody: String(s.config.templateBody).replace("\nOutputs:", "\n  BadQueue:\n    Type: AWS::SQS::Queue\n    Properties:\n      VisibilityTimeout: 99999\n\nOutputs:") });
        expect((await stackOf()).state).toBe("UPDATE_ROLLBACK_COMPLETE");
      },
      delete: async () => engine.remove(ACCOUNT, (await stackOf()).id),
    });
    expect(steps).toBe(6);
    expect(await engine.list(ACCOUNT, { service: "sqs", type: "queue", region: REGION })).toHaveLength(0);
  });

  it("completes 'Give your website a real name': zone, A record, a visit, an apex alias, a health check", { timeout: 60_000 }, async () => {
    const { request } = await import("@/engine/route53/dns");
    await play("first-web-server");
    const steps = await play("website-real-name", {
      visit: async () => {
        const res = await request(engine, ACCOUNT, "http://www.myshop.com/");
        expect(res).toMatchObject({ kind: "response", status: 200 });
      },
    });
    expect(steps).toBe(6);
    const apex = (await engine.list(ACCOUNT, { service: "route53", type: "record-set", region: "global" })).find((r) => r.name === "myshop.com" && r.config.type === "A");
    expect(apex?.config).toMatchObject({ alias: true, aliasTarget: "www.myshop.com" });
  });

  it("completes 'Keep your data safe': a data volume, a file, a snapshot, a mistake and a restore", { timeout: 60_000 }, async () => {
    const { writeVolumeFile } = await import("@/engine/services/ebs");
    await play("first-web-server");
    const write = async (content: string) => {
      const vol = (await engine.list(ACCOUNT, { service: "compute", type: "volume", region: REGION })).find((v) => v.name === "app-data")!;
      await writeVolumeFile((id) => engine.get(ACCOUNT, id), (id, p) => engine.setAttributes(ACCOUNT, id, p), vol.id, { path: "/data/orders.csv", content }, clock);
    };
    const steps = await play("disks-and-backups", {
      write: () => write("id,item\n1,book\n"),
      oops: () => write("oops, all gone"),
      restore: async () => {
        const snap = (await engine.list(ACCOUNT, { service: "compute", type: "snapshot", region: REGION }))[0];
        await engine.create(ACCOUNT, { service: "compute", type: "volume", region: REGION, config: { snapshotId: snap.id, availabilityZone: "us-east-1a", volumeType: "gp3" } });
      },
    });
    expect(steps).toBe(6);
  });

  it("completes 'Connect networks, and lock them down': peering both ways, a stateless ACL, an S3 endpoint", { timeout: 60_000 }, async () => {
    await play("first-web-server");
    const list = (type: string) => engine.list(ACCOUNT, { service: "networking", type, region: REGION });
    const steps = await play("connect-and-protect", {
      accept: async () => {
        await engine.runAction(ACCOUNT, (await list("peering-connection"))[0].id, "accept");
      },
      routes: async () => {
        const pcx = (await list("peering-connection"))[0];
        for (const t of await list("route-table")) {
          const mine = t.config.vpcId === pcx.config.vpcId;
          if (!mine && t.config.vpcId !== pcx.config.peerVpcId) continue;
          if (mine && !((t.config.subnetIds as string[]) ?? []).length) continue;
          const routes = (t.config.routes as unknown[]) ?? [];
          await engine.update(ACCOUNT, t.id, { routes: [...routes, { destination: mine ? "10.1.0.0/16" : "10.0.0.0/16", vpcPeeringConnectionId: pcx.id }] });
        }
      },
      replies: async () => {
        const acl = (await list("network-acl")).find((a) => a.name === "web-subnet-acl")!;
        await engine.update(ACCOUNT, acl.id, { outboundRules: [{ ruleNumber: 100, protocol: "tcp", fromPort: 1024, toPort: 65535, cidr: "0.0.0.0/0", action: "allow" }] });
      },
    });
    expect(steps).toBe(8);
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
