"use client";

import { useEffect, useRef } from "react";
import { api } from "@/lib/api-client";
import { useProgress, useTutorials } from "@/hooks/use-cloud";
import { useConsoleStore } from "@/stores/console-store";
import { useGuideStore } from "@/stores/guide-store";

/**
 * Keeps tutorial and challenge progress in step between this browser and the
 * server: on load, progress saved on the server (another device, or before
 * signing in) is merged in, and anything only this browser knew about is sent
 * up once. Renders nothing.
 */
export function ProgressSync() {
  const { data: server } = useProgress();
  const { data: tutorials } = useTutorials();
  const done = useRef(false);

  useEffect(() => {
    if (!server || !tutorials || done.current) return;
    done.current = true;
    const guide = useGuideStore.getState();
    const local = guide.progress;
    for (const t of tutorials) {
      const there = server.tutorials[t.id]?.steps ?? 0;
      const here = local[t.id] ?? 0;
      if (there > here) guide.setProgress(t.id, there);
      else if (here > there) void api.saveProgress({ kind: "tutorial", id: t.id, steps: Math.min(here, t.stepCount), total: t.stepCount }).catch(() => undefined);
    }
    const consoleStore = useConsoleStore.getState();
    for (const [id, r] of Object.entries(server.challenges)) {
      consoleStore.recordResult(id, { score: r.score, seconds: r.seconds, hints: r.hints, at: Date.parse(r.at) });
    }
    for (const [id, r] of Object.entries(consoleStore.results)) {
      const there = server.challenges[id];
      if (!there || there.score < r.score) void api.saveProgress({ kind: "challenge", id, score: r.score, seconds: r.seconds, hints: r.hints }).catch(() => undefined);
    }
  }, [server, tutorials]);

  return null;
}
