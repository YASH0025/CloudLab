import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { AgentBridge } from "./bridge";
import { LocalService } from "./service";
import { MemoryLocalStore } from "./store";

const ACCOUNT = "acct-bridge";
const LOCAL = "local-1";
let engine: Engine;
let local: LocalService;

beforeEach(() => {
  engine = new Engine(new MemoryStore());
  local = new LocalService(new MemoryLocalStore());
  engine.setBridge(new AgentBridge(local, engine));
});

const connect = async () => local.authenticate(`Bearer ${(await local.pair(ACCOUNT)).token}`);
const info = { hostname: "pc", platform: "linux", release: "", arch: "x64", cpus: 4, cpuModel: "", memTotal: 1, memFree: 1, docker: { ok: false }, agentVersion: "0.6.0" };
const bucket = (name: string, config: Record<string, unknown> = {}) =>
  engine.create(ACCOUNT, { service: "storage", type: "bucket", region: LOCAL, config: { name, blockPublicAccess: true, ...config } });

describe("My computer (local)", () => {
  it("needs a connected computer for buckets", async () => {
    await expect(bucket("cl-bridge-a")).rejects.toMatchObject({ code: "AgentNotConnected" });
  });

  it("sends bucket work to the computer and keeps what it reports", async () => {
    const agent = await connect();
    await bucket("cl-bridge-b");
    await engine.update(ACCOUNT, "cl-bridge-b", { blockPublicAccess: false, publicRead: true, websiteEnabled: true, indexDocument: "index.html" });
    const { tasks } = await local.sync(agent, { info, apps: [], complete: false });
    expect(tasks.map((t) => [t.payload.resource?.kind, t.payload.resource?.op])).toEqual([
      ["s3", "create-bucket"],
      ["s3", "configure-bucket"],
    ]);
    expect(tasks[1].payload.resource?.bucket).toMatchObject({ name: "cl-bridge-b", publicRead: true, websiteEnabled: true, blockPublicAccess: false });

    // The agent says the folder has two files: the bucket can't be deleted, like a non-empty S3 bucket.
    await engine.settleLocal(ACCOUNT, "cl-bridge-b", { attributes: { objectCount: 2, totalBytes: 10, websiteUrl: "http://192.168.1.5:9100/" } });
    expect((await engine.get(ACCOUNT, "cl-bridge-b")).attributes).toMatchObject({ objectCount: 2, websiteUrl: "http://192.168.1.5:9100/" });
    await expect(engine.remove(ACCOUNT, "cl-bridge-b")).rejects.toMatchObject({ code: "BucketNotEmpty" });
    await engine.settleLocal(ACCOUNT, "cl-bridge-b", { attributes: { objectCount: 0 } });
    await engine.remove(ACCOUNT, "cl-bridge-b");
    const after = await local.sync(agent, { info, apps: [], complete: false });
    expect(after.tasks.map((t) => t.payload.resource?.op)).toEqual(["delete-bucket"]);
  });

  it("keeps a local bucket's files off CloudLab's servers", async () => {
    await connect();
    await bucket("cl-bridge-c");
    await expect(engine.objects.put(ACCOUNT, "cl-bridge-c", "a.txt", Buffer.from("hi"))).rejects.toMatchObject({ code: "LocalBucket" });
    await expect(engine.objects.list(ACCOUNT, "cl-bridge-c")).rejects.toMatchObject({ code: "LocalBucket" });
  });

  it("refuses services that don't run locally yet, but allows networks (records only)", async () => {
    await engine.ensureDefaults(ACCOUNT, LOCAL);
    const vpcs = await engine.list(ACCOUNT, { service: "networking", type: "vpc", region: LOCAL });
    expect(vpcs).toHaveLength(1);
    await expect(
      engine.create(ACCOUNT, { service: "sqs", type: "queue", region: LOCAL, config: { name: "q" } }),
    ).rejects.toMatchObject({ code: "NotAvailableLocally" });
  });

  it("leaves other regions simulated", async () => {
    await engine.create(ACCOUNT, { service: "storage", type: "bucket", region: "us-east-1", config: { name: "cl-bridge-d" } });
    await engine.objects.put(ACCOUNT, "cl-bridge-d", "a.txt", Buffer.from("hi"));
    expect((await engine.objects.list(ACCOUNT, "cl-bridge-d")).objects).toHaveLength(1);
  });
});
