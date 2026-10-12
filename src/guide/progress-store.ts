import type { Engine } from "@/engine/engine";
import type { Resource } from "@/engine/types";

/** Steps done in a tutorial, and when it was first finished. */
export interface TutorialProgress {
  steps: number;
  total: number;
  completedAt?: string;
}

/** A challenge's best result. */
export interface ChallengeResult {
  score: number;
  seconds: number;
  hints: number;
  at: string;
}

export interface Progress {
  tutorials: Record<string, TutorialProgress>;
  challenges: Record<string, ChallengeResult>;
}

const find = async (engine: Engine, accountId: string): Promise<Resource | undefined> =>
  (await engine.list(accountId, { service: "guide", type: "progress", region: "global" }))[0];

export async function getProgress(engine: Engine, accountId: string): Promise<Progress> {
  const r = await find(engine, accountId);
  return {
    tutorials: (r?.attributes.tutorials as Progress["tutorials"] | undefined) ?? {},
    challenges: (r?.attributes.challenges as Progress["challenges"] | undefined) ?? {},
  };
}

async function save(engine: Engine, accountId: string, patch: Partial<Progress>) {
  const r = (await find(engine, accountId)) ?? (await engine.create(accountId, { service: "guide", type: "progress", region: "global", config: {} }));
  await engine.setAttributes(accountId, r.id, patch);
}

/** Records where the learner is in a tutorial. A finished tutorial stays finished, even after a restart. */
export async function saveTutorial(engine: Engine, accountId: string, id: string, steps: number, total: number) {
  const { tutorials } = await getProgress(engine, accountId);
  const before = tutorials[id];
  const completedAt = before?.completedAt ?? (steps >= total ? engine.now().toISOString() : undefined);
  await save(engine, accountId, { tutorials: { ...tutorials, [id]: { steps, total, ...(completedAt ? { completedAt } : {}) } } });
}

/** Keeps a challenge's best result: the highest score, then the fastest time. */
export async function saveChallenge(engine: Engine, accountId: string, id: string, result: Omit<ChallengeResult, "at">) {
  const { challenges } = await getProgress(engine, accountId);
  const best = challenges[id];
  if (best && (best.score > result.score || (best.score === result.score && best.seconds <= result.seconds))) return;
  await save(engine, accountId, { challenges: { ...challenges, [id]: { ...result, at: engine.now().toISOString() } } });
}

/** After a lab reset the resources are gone, so tutorials start again from step 1 (finished ones stay finished). */
export async function resetTutorialSteps(engine: Engine, accountId: string) {
  const { tutorials } = await getProgress(engine, accountId);
  if (Object.keys(tutorials).length === 0) return;
  await save(engine, accountId, { tutorials: Object.fromEntries(Object.entries(tutorials).map(([id, t]) => [id, { ...t, steps: 0 }])) });
}
