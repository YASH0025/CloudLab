import { beforeEach, describe, expect, it } from "vitest";
import { LocalService, MAX_APPS } from "./service";
import { MemoryLocalStore } from "./store";
import type { SyncBody } from "./types";

const ACCOUNT = "acct-local";
let clock: Date;
let local: LocalService;

const info: SyncBody["info"] = {
  hostname: "laptop",
  platform: "linux",
  release: "6.8",
  arch: "x64",
  cpus: 8,
  cpuModel: "Test CPU",
  memTotal: 16e9,
  memFree: 8e9,
  docker: { ok: true, version: "27.0.1" },
  agentVersion: "0.1.0",
};

beforeEach(() => {
  clock = new Date("2026-10-12T10:00:00Z");
  local = new LocalService(new MemoryLocalStore(), () => clock);
});

const connect = async () => {
  const { token } = await local.pair(ACCOUNT);
  return local.authenticate(`Bearer ${token}`);
};

describe("local mode", () => {
  it("pairs a computer with a token that only works until it's replaced", async () => {
    const { token, agent } = await local.pair(ACCOUNT);
    expect(token).toMatch(/^cla_/);
    expect(agent.online).toBe(false);
    const a = await local.authenticate(`Bearer ${token}`);
    await local.sync(a, { info, apps: [], complete: true });
    expect((await local.status(ACCOUNT)).agent).toMatchObject({ online: true, info: { hostname: "laptop" } });

    // Connecting again replaces the old computer: the old token is refused.
    await local.pair(ACCOUNT);
    await expect(local.authenticate(`Bearer ${token}`)).rejects.toMatchObject({ code: "AgentUnauthorized", status: 401 });
    await expect(local.authenticate(null)).rejects.toMatchObject({ code: "AgentUnauthorized" });
  });

  it("goes offline when the agent stops checking in", async () => {
    const a = await connect();
    await local.sync(a, { info, apps: [], complete: true });
    clock = new Date(clock.getTime() + 30_000);
    expect((await local.status(ACCOUNT)).agent?.online).toBe(false);
  });

  it("queues a deploy, hands it to the agent once, and records progress", async () => {
    await expect(local.deploy(ACCOUNT, { name: "web", source: { type: "sample", sample: "static-site" } })).rejects.toMatchObject({ code: "AgentNotConnected" });
    const a = await connect();
    const app = await local.deploy(ACCOUNT, { name: "web", source: { type: "sample", sample: "static-site" }, hostPort: 8080 });
    expect(app).toMatchObject({ status: "queued", hostPort: 8080 });

    const [task] = await local.sync(a, { info, apps: [], complete: false });
    expect(task).toMatchObject({ type: "deploy", payload: { appId: app.id, name: "web", source: { type: "sample", sample: "static-site" }, hostPort: 8080 } });
    expect(await local.sync(a, { info, apps: [], complete: false })).toEqual([]);

    await local.report(a, app.id, { status: "building", detail: "Building the image…", buildLog: "Step 1/2" });
    expect((await local.status(ACCOUNT)).apps[0]).toMatchObject({ status: "building", buildLog: "Step 1/2", url: null });
    await local.report(a, app.id, { status: "running", detail: "Running", containerPort: 80 });
    expect((await local.status(ACCOUNT)).apps[0]).toMatchObject({ status: "running", url: "http://localhost:8080" });
    await local.finishTask(a, task.id, "done");
  });

  it("refuses duplicate names, taken ports and too many apps", async () => {
    await connect();
    await local.deploy(ACCOUNT, { name: "web", source: { type: "sample", sample: "static-site" }, hostPort: 8080 });
    await expect(local.deploy(ACCOUNT, { name: "web", source: { type: "sample", sample: "node-express" } })).rejects.toMatchObject({ code: "AppAlreadyExists" });
    await expect(local.deploy(ACCOUNT, { name: "api", source: { type: "sample", sample: "node-express" }, hostPort: 8080 })).rejects.toMatchObject({ code: "PortInUse" });
    for (let i = 1; i < MAX_APPS; i++) await local.deploy(ACCOUNT, { name: `app-${i}`, source: { type: "sample", sample: "static-site" } });
    await expect(local.deploy(ACCOUNT, { name: "one-more", source: { type: "sample", sample: "static-site" } })).rejects.toMatchObject({ code: "AppLimitExceeded" });
  });

  it("sends start, stop and remove to the agent, and marks vanished containers missing", async () => {
    const a = await connect();
    const app = await local.deploy(ACCOUNT, { name: "web", source: { type: "sample", sample: "static-site" } });
    await local.sync(a, { info, apps: [], complete: false });
    await local.report(a, app.id, { status: "running", hostPort: 8081 });

    await local.action(ACCOUNT, app.id, "stop");
    expect((await local.sync(a, { info, apps: [{ id: app.id, status: "running" }], complete: true })).map((t) => t.type)).toEqual(["stop"]);

    // The container disappeared from the computer (removed by hand).
    await local.sync(a, { info, apps: [], complete: true });
    expect((await local.status(ACCOUNT)).apps[0].status).toBe("missing");

    expect(await local.action(ACCOUNT, app.id, "delete")).toBeNull();
    expect((await local.status(ACCOUNT)).apps).toEqual([]);
    expect((await local.sync(a, { info, apps: [], complete: true })).map((t) => t.type)).toEqual(["remove"]);
    await expect(local.action(ACCOUNT, app.id, "start")).rejects.toMatchObject({ code: "AppNotFound" });
  });

  it("keeps apps apart between accounts", async () => {
    const a = await connect();
    const app = await local.deploy(ACCOUNT, { name: "web", source: { type: "sample", sample: "static-site" } });
    await local.pair("someone-else");
    await expect(local.action("someone-else", app.id, "stop")).rejects.toMatchObject({ code: "AppNotFound" });
    // An agent can't report on another account's app.
    const { token } = await local.pair("other");
    const other = await local.authenticate(`Bearer ${token}`);
    await local.report(other, app.id, { status: "failed" });
    expect((await local.status(ACCOUNT)).apps[0].status).toBe("queued");
    expect(a.accountId).toBe(ACCOUNT);
  });
});
