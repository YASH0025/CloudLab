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
    expect(listTutorials().map((t) => t.id)).toEqual(["first-network", "first-web-server", "troubleshoot-reachability"]);
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
});
