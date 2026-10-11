"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface ConsoleState {
  region: string;
  setRegion: (region: string) => void;
  /** The IAM identity the console and terminal act as: "root", "user/<name>" or "role/<name>". */
  identity: string;
  setIdentity: (identity: string) => void;
  /** "lab" (the learner's own resources) or "challenge" (a separate account with a broken setup to fix). */
  workspace: "lab" | "challenge";
  /** The challenge being played, while in the challenge workspace. */
  challenge: { id: string; startedAt: number; hintsUsed: number } | null;
  /** Switches into a challenge (or back to the lab, with null). Acting as root in either. */
  setChallenge: (challenge: { id: string; startedAt: number; hintsUsed: number } | null) => void;
  takeHint: () => void;
  /** Best result per challenge: score out of 100, seconds taken, hints used. */
  results: Record<string, { score: number; seconds: number; hints: number; at: number }>;
  recordResult: (id: string, result: { score: number; seconds: number; hints: number; at: number }) => void;
}

/** Console-wide client state. The selected region is remembered between visits. */
export const useConsoleStore = create<ConsoleState>()(
  persist(
    (set) => ({
      region: "us-east-1",
      setRegion: (region) => set({ region }),
      identity: "root",
      setIdentity: (identity) => set({ identity }),
      workspace: "lab",
      challenge: null,
      setChallenge: (challenge) => set({ challenge, workspace: challenge ? "challenge" : "lab", identity: "root" }),
      takeHint: () => set((s) => (s.challenge ? { challenge: { ...s.challenge, hintsUsed: Math.min(s.challenge.hintsUsed + 1, 3) } } : {})),
      results: {},
      recordResult: (id, result) =>
        set((s) => {
          const best = s.results[id];
          return best && best.score >= result.score ? {} : { results: { ...s.results, [id]: result } };
        }),
    }),
    {
      name: "cloudlab-console",
      storage: createJSONStorage(() => localStorage),
      // Restored after hydration (see Providers) so server and first client render match.
      skipHydration: true,
    },
  ),
);
