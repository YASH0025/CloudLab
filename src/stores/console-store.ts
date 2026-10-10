"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface ConsoleState {
  region: string;
  setRegion: (region: string) => void;
  /** The IAM identity the console and terminal act as: "root", "user/<name>" or "role/<name>". */
  identity: string;
  setIdentity: (identity: string) => void;
}

/** Console-wide client state. The selected region is remembered between visits. */
export const useConsoleStore = create<ConsoleState>()(
  persist(
    (set) => ({
      region: "us-east-1",
      setRegion: (region) => set({ region }),
      identity: "root",
      setIdentity: (identity) => set({ identity }),
    }),
    {
      name: "cloudlab-console",
      storage: createJSONStorage(() => localStorage),
      // Restored after hydration (see Providers) so server and first client render match.
      skipHydration: true,
    },
  ),
);
