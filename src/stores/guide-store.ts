"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface LastError {
  code: string;
  message: string;
  at: number;
}

interface GuideState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
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
      lastError: null,
      setLastError: (error) => set({ lastError: error ? { ...error, at: Date.now() } : null }),
    }),
    {
      name: "cloudlab-guide",
      storage: createJSONStorage(() => localStorage),
      // Restored after hydration (see Providers) so server and first client render match.
      skipHydration: true,
      // Only whether the panel is open is remembered; errors are per visit.
      partialize: (s) => ({ open: s.open }),
    },
  ),
);
