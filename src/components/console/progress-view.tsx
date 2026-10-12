"use client";

import { ArrowRightIcon, BookOpenIcon, CheckCircle2Icon, CircleIcon, ClockIcon, SwordsIcon, TrophyIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TOPIC_OF, TOPICS } from "@/guide/topics";
import { useChallenges, useMe, useProgress, useStartChallenge, useTutorials } from "@/hooks/use-cloud";
import { cn } from "@/lib/utils";
import { useConsoleStore } from "@/stores/console-store";
import { useGuideStore } from "@/stores/guide-store";

const LEVEL = { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" } as const;

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </CardContent>
    </Card>
  );
}

const duration = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`);

/** Everything the learner has done: tutorials, challenges, and how each skill area is coming along. */
export function ProgressView() {
  const tutorials = useTutorials();
  const challenges = useChallenges();
  const server = useProgress();
  const me = useMe();
  const localSteps = useGuideStore((s) => s.progress);
  const startTutorial = useGuideStore((s) => s.startTutorial);
  const localResults = useConsoleStore((s) => s.results);
  const startChallenge = useStartChallenge();

  if (tutorials.isLoading || challenges.isLoading) return <Skeleton className="h-96" />;
  const tList = tutorials.data ?? [];
  const cList = challenges.data ?? [];

  // The server is the record; this browser may know a little more (offline, or just now).
  const stepsOf = (id: string, total: number) => Math.min(total, Math.max(server.data?.tutorials[id]?.steps ?? 0, localSteps[id] ?? 0));
  const finished = (id: string, total: number) => !!server.data?.tutorials[id]?.completedAt || stepsOf(id, total) >= total;
  const resultOf = (id: string) => {
    const s = server.data?.challenges[id];
    const l = localResults[id];
    if (s && l) return s.score >= l.score ? { ...s } : { ...l };
    return s ?? (l ? { ...l } : undefined);
  };

  const doneTutorials = tList.filter((t) => finished(t.id, t.stepCount));
  const solved = cList.filter((c) => resultOf(c.id));
  const points = solved.reduce((n, c) => n + (resultOf(c.id)?.score ?? 0), 0);
  const steps = tList.reduce((n, t) => n + stepsOf(t.id, t.stepCount), 0);
  const totalSteps = tList.reduce((n, t) => n + t.stepCount, 0);
  const next = tList.find((t) => !finished(t.id, t.stepCount));
  const nextChallenge = cList.find((c) => !resultOf(c.id));
  const signedIn = !!me.data?.user;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My progress</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Tutorials you&apos;ve followed and challenges you&apos;ve fixed.{" "}
          {signedIn ? "Saved to your account, so it follows you on every device." : "Saved with this browser's lab. Sign in to keep it on every device."}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Tutorials finished" value={`${doneTutorials.length} / ${tList.length}`} />
        <Stat label="Tutorial steps done" value={`${steps} / ${totalSteps}`} />
        <Stat label="Challenges fixed" value={`${solved.length} / ${cList.length}`} />
        <Stat label="Challenge points" value={String(points)} detail={`out of ${cList.length * 100}`} />
      </div>

      {(next || nextChallenge) && (
        <Card>
          <CardHeader>
            <CardTitle>Up next</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 pb-5 md:grid-cols-2">
            {next && (
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <BookOpenIcon className="size-3.5" /> Tutorial · {LEVEL[next.level]} · ~{next.minutes} min
                  </p>
                  <p className="font-medium">{next.title}</p>
                  {stepsOf(next.id, next.stepCount) > 0 && <p className="text-xs text-muted-foreground">{stepsOf(next.id, next.stepCount)} of {next.stepCount} steps done</p>}
                </div>
                <Button size="sm" onClick={() => startTutorial(next.id)}>
                  {stepsOf(next.id, next.stepCount) > 0 ? "Continue" : "Start"} <ArrowRightIcon />
                </Button>
              </div>
            )}
            {nextChallenge && (
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <SwordsIcon className="size-3.5" /> Challenge · {LEVEL[nextChallenge.level]} · ~{nextChallenge.minutes} min
                  </p>
                  <p className="font-medium">{nextChallenge.title}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={startChallenge.isPending}
                  onClick={() => {
                    startChallenge.mutate(nextChallenge.id);
                    useGuideStore.getState().setTab("challenges");
                    useGuideStore.getState().setOpen(true);
                  }}
                >
                  Start
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Skills</CardTitle>
          <CardDescription>Each tutorial and challenge trains one area. A full bar means you&apos;ve done all of them.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-x-8 gap-y-5 pb-5 sm:grid-cols-2">
          {TOPICS.map((topic) => {
            const ts = tList.filter((t) => TOPIC_OF[t.id] === topic);
            const cs = cList.filter((c) => TOPIC_OF[c.id] === topic);
            const total = ts.length + cs.length;
            if (total === 0) return null;
            const done = ts.filter((t) => finished(t.id, t.stepCount)).length + cs.filter((c) => resultOf(c.id)).length;
            return (
              <div key={topic} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{topic}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {done} of {total}
                  </span>
                </div>
                <Bar value={done / total} label={`${topic}: ${done} of ${total}`} />
                <ul className="space-y-0.5 text-xs">
                  {[...ts.map((t) => ({ id: t.id, title: t.title, ok: finished(t.id, t.stepCount), kind: "tutorial" })), ...cs.map((c) => ({ id: c.id, title: c.title, ok: !!resultOf(c.id), kind: "challenge" }))].map((x) => (
                    <li key={x.id} className={cn("flex items-center gap-1.5", !x.ok && "text-muted-foreground")}>
                      {x.ok ? <CheckCircle2Icon className="size-3.5 shrink-0 text-success" /> : <CircleIcon className="size-3.5 shrink-0" />}
                      <span className="min-w-0 truncate">{x.title}</span>
                      {x.kind === "challenge" && <SwordsIcon className="size-3 shrink-0" aria-label="challenge" />}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpenIcon className="size-4" /> Tutorials
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-5">
            <ul className="divide-y">
              {tList.map((t) => {
                const n = stepsOf(t.id, t.stepCount);
                const ok = finished(t.id, t.stepCount);
                return (
                  <li key={t.id} className="flex items-center gap-3 py-2.5">
                    {ok ? <CheckCircle2Icon className="size-4 shrink-0 text-success" /> : <CircleIcon className="size-4 shrink-0 text-muted-foreground" />}
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <button type="button" className="min-w-0 truncate text-left text-sm hover:underline" onClick={() => startTutorial(t.id)}>
                          {t.title}
                        </button>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {n}/{t.stepCount}
                        </span>
                      </div>
                      {!ok && n > 0 && <Bar value={n / t.stepCount} label={`${t.title}: ${n} of ${t.stepCount} steps`} />}
                    </div>
                    <Badge variant="secondary" className="hidden sm:inline-flex">
                      {LEVEL[t.level]}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SwordsIcon className="size-4" /> Challenges
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-5">
            <ul className="divide-y">
              {cList.map((c) => {
                const r = resultOf(c.id);
                return (
                  <li key={c.id} className="flex items-center gap-3 py-2.5">
                    {r ? <TrophyIcon className="size-4 shrink-0 text-success" /> : <CircleIcon className="size-4 shrink-0 text-muted-foreground" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{c.title}</p>
                      {r ? (
                        <p className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground tabular-nums">{r.score} pts</span>
                          <span className="flex items-center gap-1 tabular-nums">
                            <ClockIcon className="size-3" /> {duration(r.seconds)}
                          </span>
                          <span>
                            {r.hints} hint{r.hints === 1 ? "" : "s"}
                          </span>
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">Not fixed yet · ~{c.minutes} min</p>
                      )}
                    </div>
                    <Badge variant="secondary" className="hidden sm:inline-flex">
                      {LEVEL[c.level]}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
