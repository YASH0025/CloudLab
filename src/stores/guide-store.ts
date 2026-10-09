"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface LastError {
  code: string;
  message: string;
  at: number;
}

export type GuideTab = "tutorials" | "next";

interface GuideState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  tab: GuideTab;
  setTab: (tab: GuideTab) => void;

  /** The tutorial being followed, if any. */
  activeTutorial: string | null;
  /** Completed step count per tutorial ID. */
  progress: Record<string, number>;
  startTutorial: (id: string) => void;
  leaveTutorial: () => void;
  setProgress: (id: string, completed: number) => void;
  restartTutorial: (id: string) => void;

  /** The most recent failed action, so the guide can explain it. */
  lastError: LastError | null;
  setLastError: (error: { code: string; message: string } | null) => void;
}

export const useGuideStore = create<GuideState>()(
  persist(
    (set) => ({
      open: false,
      setOpen: (open) => set({ open }),
      toggle: () => set((s) => ({ open: !s.open })),
      tab: "tutorials",
      setTab: (tab) => set({ tab }),

      activeTutorial: null,
      progress: {},
      startTutorial: (id) => set({ activeTutorial: id, tab: "tutorials", open: true }),
      leaveTutorial: () => set({ activeTutorial: null }),
      setProgress: (id, completed) => set((s) => ({ progress: { ...s.progress, [id]: completed } })),
      restartTutorial: (id) => set((s) => ({ progress: { ...s.progress, [id]: 0 } })),

      lastError: null,
      setLastError: (error) => set({ lastError: error ? { ...error, at: Date.now() } : null }),
    }),
    {
      name: "cloudlab-guide",
      storage: createJSONStorage(() => localStorage),
      // Restored after hydration (see Providers) so server and first client render match.
      skipHydration: true,
      // Panel state and tutorial progress are remembered; errors are per visit.
      partialize: (s) => ({ open: s.open, tab: s.tab, activeTutorial: s.activeTutorial, progress: s.progress }),
    },
  ),
);
