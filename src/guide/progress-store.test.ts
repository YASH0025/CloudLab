import { describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { getProgress, resetTutorialSteps, saveChallenge, saveTutorial } from "./progress-store";

describe("saved progress", () => {
  it("keeps tutorial steps, finished tutorials and best challenge results", async () => {
    const engine = new Engine(new MemoryStore(), () => new Date("2026-10-01T10:00:00Z"));
    const A = "acct-progress";
    expect(await getProgress(engine, A)).toEqual({ tutorials: {}, challenges: {} });
    await saveTutorial(engine, A, "first-network", 2, 4);
    await saveTutorial(engine, A, "first-network", 4, 4);
    await resetTutorialSteps(engine, A);
    const p = await getProgress(engine, A);
    expect(p.tutorials["first-network"]).toEqual({ steps: 0, total: 4, completedAt: "2026-10-01T10:00:00.000Z" });

    await saveChallenge(engine, A, "site-down", { score: 70, seconds: 300, hints: 2 });
    await saveChallenge(engine, A, "site-down", { score: 40, seconds: 100, hints: 3 });
    await saveChallenge(engine, A, "site-down", { score: 90, seconds: 400, hints: 1 });
    expect((await getProgress(engine, A)).challenges["site-down"]).toMatchObject({ score: 90, seconds: 400 });
    // Not shown as a resource anywhere.
    expect(await engine.list(A, { region: "global" })).toHaveLength(1);
  });
});
