"use client";

import { ArrowLeftIcon, ArrowRightIcon, ClockIcon, FlagIcon, LightbulbIcon, Loader2Icon, PartyPopperIcon, RotateCcwIcon, SwordsIcon, TrophyIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useChallenge, useChallenges, useSaveProgress, useStartChallenge } from "@/hooks/use-cloud";
import type { ChallengeInfo } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useConsoleStore } from "@/stores/console-store";

const LEVEL: Record<ChallengeInfo["level"], string> = { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" };
const HINT_COST = [10, 20, 30];
const scoreFor = (hints: number) => 100 - HINT_COST.slice(0, hints).reduce((a, b) => a + b, 0);

function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** A clock that ticks every second while the challenge is being played. */
function useElapsed(startedAt: number, stopped: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (stopped) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [stopped]);
  return now - startedAt;
}

/** Leaves the challenge workspace and goes back to the learner's own lab. */
function useBackToLab() {
  const qc = useQueryClient();
  const setChallenge = useConsoleStore((s) => s.setChallenge);
  return () => {
    setChallenge(null);
    qc.resetQueries();
  };
}

// ---------- list ----------

function ChallengeList() {
  const { data, isLoading } = useChallenges();
  const results = useConsoleStore((s) => s.results);
  const start = useStartChallenge();
  const [confirm, setConfirm] = useState<string | null>(null);

  if (isLoading) return <Skeleton className="h-64" />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Something is broken, and nobody tells you how to fix it. Investigate with the console and terminal like on a real job. Each challenge runs in a separate challenge account: your own lab isn&apos;t touched.
      </p>
      {data?.map((c) => {
        const best = results[c.id];
        return (
          <div key={c.id} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{c.title}</p>
              {best ? (
                <Badge variant="success" title={`Best: ${best.score} points in ${duration(best.seconds * 1000)}, ${best.hints} hint${best.hints === 1 ? "" : "s"}`}>
                  <TrophyIcon className="size-3" /> {best.score}
                </Badge>
              ) : (
                <Badge variant="secondary">{LEVEL[c.level]}</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{c.summary}</p>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <ClockIcon className="size-3.5" /> ~{c.minutes} min
              </span>
              {confirm === c.id ? (
                <span className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => start.mutate(c.id)} disabled={start.isPending}>
                    {start.isPending ? <Loader2Icon className="animate-spin" /> : <SwordsIcon />} Build it and start
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirm(c.id)}>
                  {best ? "Play again" : "Start"}
                </Button>
              )}
            </div>
            {confirm === c.id && (
              <p className="text-xs text-muted-foreground">
                Nuvora builds the broken setup in your challenge account (anything left there from an earlier challenge is wiped) and switches the console to it.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- playing ----------

function ChallengeRunner({ id, startedAt, hintsUsed }: { id: string; startedAt: number; hintsUsed: number }) {
  const { data: c, isLoading, isError } = useChallenge(id, hintsUsed);
  const { data: all } = useChallenges();
  const takeHint = useConsoleStore((s) => s.takeHint);
  const recordResult = useConsoleStore((s) => s.recordResult);
  const saveProgress = useSaveProgress();
  const back = useBackToLab();
  const start = useStartChallenge();
  const solved = c?.solved === true;
  const elapsed = useElapsed(startedAt, solved);
  const recorded = useRef(false);
  const [solvedAfter, setSolvedAfter] = useState<number | null>(null);

  // Record the result once, the first time the check passes.
  useEffect(() => {
    if (!solved || recorded.current) return;
    recorded.current = true;
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    setSolvedAfter(seconds);
    recordResult(id, { score: scoreFor(hintsUsed), seconds, hints: hintsUsed, at: Date.now() });
    saveProgress.mutate({ kind: "challenge", id, score: scoreFor(hintsUsed), seconds, hints: hintsUsed });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the mutation object changes every render
  }, [solved, id, hintsUsed, startedAt, recordResult]);

  if (isLoading) return <Skeleton className="h-80" />;
  if (isError || !c) return <p className="text-sm text-destructive">Couldn&apos;t load this challenge.</p>;
  const index = all?.findIndex((x) => x.id === id) ?? -1;
  const next = index >= 0 ? all?.[index + 1] : undefined;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={back}>
          <ArrowLeftIcon /> Back to my lab
        </Button>
        <Button variant="ghost" size="sm" onClick={() => start.mutate(id)} disabled={start.isPending}>
          <RotateCcwIcon className={cn(start.isPending && "animate-spin")} /> Rebuild
        </Button>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{LEVEL[c.level]}</Badge>
          <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
            <ClockIcon className="size-3.5" /> {duration(solvedAfter !== null ? solvedAfter * 1000 : elapsed)}
          </span>
          <span className="text-xs text-muted-foreground">· {scoreFor(hintsUsed)} points</span>
        </div>
        <h2 className="font-semibold">{c.title}</h2>
      </div>

      {solved ? (
        <div className="space-y-3 rounded-lg border border-success/40 bg-success/10 p-4">
          <p className="flex items-center gap-2 font-semibold">
            <PartyPopperIcon className="size-4 text-success" /> Fixed! {scoreFor(hintsUsed)} points
          </p>
          <p className="text-sm">{c.explanation}</p>
          <div className="flex flex-wrap gap-2">
            {next && (
              <Button size="sm" onClick={() => start.mutate(next.id)} disabled={start.isPending}>
                Next: {next.title} <ArrowRightIcon />
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={back}>
              Back to my lab
            </Button>
          </div>
        </div>
      ) : (
        <p className="flex items-start gap-1.5 rounded-md border bg-muted/40 p-2.5 text-xs text-muted-foreground">
          <Loader2Icon className="mt-0.5 size-3 shrink-0 animate-spin" />
          <span>
            Not fixed yet{c.status ? `: ${c.status}` : "."} Checked every few seconds; it passes by itself once it works.
          </span>
        </p>
      )}

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <FlagIcon className="size-3.5" /> The problem
        </h3>
        <p className="text-sm text-muted-foreground">{c.story}</p>
        <ul className="space-y-0.5 rounded-md bg-muted p-2 font-mono text-xs break-all">
          {c.facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-sm font-medium">Done when</h3>
        <p className="text-sm text-muted-foreground">{c.goal}</p>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-sm font-medium">Where to look</h3>
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
          {c.tools.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <LightbulbIcon className="size-3.5" /> Hints ({c.hints.length}/{c.hintCount})
        </h3>
        {c.hints.map((h, i) => (
          <p key={i} className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-sm">
            <span className="font-medium">Hint {i + 1}: </span>
            {h}
          </p>
        ))}
        {!solved && hintsUsed < c.hintCount && (
          <Button size="sm" variant="outline" onClick={takeHint}>
            <LightbulbIcon /> Show hint {hintsUsed + 1} (−{HINT_COST[hintsUsed]} points)
          </Button>
        )}
      </section>
    </div>
  );
}

/** The Guide's Challenges tab. */
export function ChallengesTab() {
  const challenge = useConsoleStore((s) => s.challenge);
  return challenge ? <ChallengeRunner key={`${challenge.id}-${challenge.startedAt}`} {...challenge} /> : <ChallengeList />;
}

/** Shown above every console page while a challenge is being played, so it's clear which account you're in. */
export function ChallengeBanner() {
  const challenge = useConsoleStore((s) => s.challenge);
  const { data: all } = useChallenges();
  const back = useBackToLab();
  if (!challenge) return null;
  const title = all?.find((c) => c.id === challenge.id)?.title ?? "Challenge";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm sm:px-6">
      <p className="flex items-center gap-2">
        <SwordsIcon className="size-4 shrink-0" />
        <span>
          <span className="font-medium">Challenge: {title}.</span> <span className="text-muted-foreground">You&apos;re in the challenge account, not your lab.</span>
        </span>
      </p>
      <Button size="sm" variant="outline" onClick={back}>
        <ArrowLeftIcon /> Back to my lab
      </Button>
    </div>
  );
}
