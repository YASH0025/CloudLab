"use client";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  CompassIcon,
  Loader2Icon,
  PartyPopperIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { explainError } from "@/guide/errors";
import { advanceProgress } from "@/guide/progress";
import type { GuideLink, Level, Suggestion, TutorialStepView } from "@/guide/types";
import { useGuide, useTutorial, useTutorials } from "@/hooks/use-cloud";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { useGuideStore, type GuideTab } from "@/stores/guide-store";

const levelLabel: Record<Level, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

function hrefFor(link: GuideLink): string {
  if (link.mode === "create") {
    return link.prefill
      ? routes.createPrefilled(link.service, link.type, link.prefill)
      : routes.create(link.service, link.type);
  }
  if (link.mode === "detail" && link.id) return routes.detail(link.service, link.type, link.id);
  return routes.list(link.service, link.type);
}

// ---------- shared pieces ----------

function NumberedSteps({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-1.5 text-sm">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-2">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {i + 1}
          </span>
          <span>
            <WithFileLinks text={step} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Turns sample-file paths in an instruction (e.g. /samples/website/index.html) into download links. */
function WithFileLinks({ text }: { text: string }) {
  const parts = text.split(/(\/samples\/[\w./-]+\.\w+)/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} download className="font-mono text-xs text-primary hover:underline">
            {part.split("/").pop()}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Actions({ link, cli }: { link?: GuideLink; cli?: string }) {
  if (!link && !cli) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {link && (
          <Button asChild size="sm">
            <Link href={hrefFor(link)}>
              Take me there <ArrowRightIcon />
            </Link>
          </Button>
        )}
        {cli && (
          <Button asChild size="sm" variant="outline">
            <Link href={routes.terminalWith(cli)}>
              <SquareTerminalIcon /> Do it in the terminal
            </Link>
          </Button>
        )}
      </div>
      {cli && (
        <pre className="overflow-x-auto rounded-md bg-muted px-2.5 py-2 font-mono text-xs whitespace-pre-wrap break-all">
          {cli}
        </pre>
      )}
    </div>
  );
}

function LastErrorCard() {
  const lastError = useGuideStore((s) => s.lastError);
  const clear = useGuideStore((s) => s.setLastError);
  if (!lastError) return null;
  const explained = explainError(lastError.code);
  return (
    <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/6 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 font-medium">
          <TriangleAlertIcon className="size-4 text-destructive" />
          Your last action failed
        </p>
        <button type="button" aria-label="Dismiss" onClick={() => clear(null)} className="opacity-60 hover:opacity-100">
          <XIcon className="size-4" />
        </button>
      </div>
      <p className="font-mono text-xs text-destructive">{lastError.code}</p>
      <p className="text-muted-foreground">{lastError.message}</p>
      {explained && (
        <div className="space-y-1 border-t border-destructive/20 pt-2">
          <p>
            <span className="font-medium">What it means: </span>
            {explained.meaning}
          </p>
          <p>
            <span className="font-medium">How to fix it: </span>
            {explained.fix}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------- "Next step" tab ----------

function SuggestionBody({ s }: { s: Suggestion }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{s.why}</p>
      <NumberedSteps steps={s.steps} />
      {!s.waiting && <Actions link={s.link} cli={s.cli} />}
    </div>
  );
}

function MoreIdea({ s }: { s: Suggestion }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
        aria-expanded={open}
      >
        <span>
          {s.title}
          <span className="ml-2 text-xs text-muted-foreground">{levelLabel[s.level]}</span>
        </span>
        <ChevronDownIcon className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t px-3 py-3">
          <SuggestionBody s={s} />
        </div>
      )}
    </div>
  );
}

function NextStepTab() {
  const guide = useGuide(true);
  const advice = guide.data;
  const done = advice?.milestones.filter((m) => m.done).length ?? 0;
  const total = advice?.milestones.length ?? 0;

  if (guide.isLoading) return <Skeleton className="h-64" />;
  if (guide.isError || !advice) return <p className="text-sm text-destructive">Couldn&apos;t load the guide. Try refreshing.</p>;

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Stuck? This looks at what you&apos;ve built so far and suggests the most useful next thing to do.
      </p>
      <section className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
        <p className="flex items-center justify-between text-xs font-medium tracking-wide text-primary uppercase">
          Next step <Badge variant="secondary">{levelLabel[advice.level]}</Badge>
        </p>
        <h2 className="flex items-start gap-2 font-semibold">
          {advice.next.waiting && <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />}
          {advice.next.title}
        </h2>
        <SuggestionBody s={advice.next} />
      </section>

      {advice.more.length > 0 && (
        <section className="space-y-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Also worth doing</p>
          {advice.more.map((s) => (
            <MoreIdea key={s.id} s={s} />
          ))}
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <span>Your progress in {advice.region}</span>
          <span>
            {done}/{total}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-success transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
        <ul className="space-y-1 pt-1 text-sm">
          {advice.milestones.map((m) => (
            <li key={m.id} className={cn("flex items-center gap-2", !m.done && "text-muted-foreground")}>
              {m.done ? <CheckCircle2Icon className="size-4 text-success" /> : <CircleIcon className="size-4" />}
              {m.label}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---------- "Tutorials" tab ----------

function TutorialList() {
  const { data, isLoading } = useTutorials();
  const progress = useGuideStore((s) => s.progress);
  const start = useGuideStore((s) => s.startTutorial);

  if (isLoading) return <Skeleton className="h-64" />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        New to the cloud? Pick a tutorial and it will walk you through every step, from the first click to the last.
      </p>
      {data?.map((t, i) => {
        const done = Math.min(progress[t.id] ?? 0, t.stepCount);
        const finished = done === t.stepCount;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => start(t.id)}
            className="block w-full space-y-2 rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">
                <span className="mr-1.5 text-muted-foreground">{i + 1}.</span>
                {t.title}
              </p>
              {finished ? (
                <CheckCircle2Icon className="size-4 shrink-0 text-success" />
              ) : (
                <Badge variant="secondary">{levelLabel[t.level]}</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{t.summary}</p>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <ClockIcon className="size-3.5" /> ~{t.minutes} min
              </span>
              <span>
                {done > 0 ? `${done}/${t.stepCount} steps done` : `${t.stepCount} steps`}
              </span>
            </div>
            {done > 0 && !finished && (
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary" style={{ width: `${(done / t.stepCount) * 100}%` }} />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function CurrentStep({ step, index }: { step: TutorialStepView; index: number }) {
  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <p className="text-xs font-medium tracking-wide text-primary uppercase">Step {index + 1}</p>
      <h3 className="font-semibold">{step.title}</h3>
      <p className="text-sm text-muted-foreground">{step.why}</p>
      <NumberedSteps steps={step.instructions} />
      <Actions link={step.link} cli={step.cli} />
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" /> Waiting for you. This step ticks off by itself when it&apos;s done.
      </p>
    </div>
  );
}

function TutorialRunner({ id }: { id: string }) {
  const { data: tutorial, isLoading, isError } = useTutorial(id);
  const { data: all } = useTutorials();
  const completed = useGuideStore((s) => s.progress[id] ?? 0);
  const setProgress = useGuideStore((s) => s.setProgress);
  const restart = useGuideStore((s) => s.restartTutorial);
  const leave = useGuideStore((s) => s.leaveTutorial);
  const start = useGuideStore((s) => s.startTutorial);

  // Steps tick off in order as the learner's resources start satisfying them.
  useEffect(() => {
    if (!tutorial) return;
    const next = advanceProgress(completed, tutorial.steps.map((s) => s.passes));
    if (next > completed) {
      setProgress(id, next);
      const last = tutorial.steps[next - 1];
      toast.success(next === tutorial.steps.length ? "Tutorial complete!" : `Step done: ${last.title}`);
    }
  }, [tutorial, completed, id, setProgress]);

  if (isLoading) return <Skeleton className="h-80" />;
  if (isError || !tutorial) return <p className="text-sm text-destructive">Couldn&apos;t load this tutorial.</p>;

  const total = tutorial.steps.length;
  const done = Math.min(completed, total);
  const finished = done === total;
  const nextTutorial = tutorial.nextId ? all?.find((t) => t.id === tutorial.nextId) : undefined;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={leave}>
          <ArrowLeftIcon /> All tutorials
        </Button>
        <Button variant="ghost" size="sm" onClick={() => restart(id)} disabled={done === 0}>
          <RotateCcwIcon /> Restart
        </Button>
      </div>

      <div className="space-y-2">
        <h2 className="font-semibold">{tutorial.title}</h2>
        <p className="text-sm text-muted-foreground">{tutorial.summary}</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-success transition-all" style={{ width: `${(done / total) * 100}%` }} />
          </div>
          {done}/{total}
        </div>
      </div>

      {finished && (
        <div className="space-y-3 rounded-lg border border-success/40 bg-success/10 p-4">
          <p className="flex items-center gap-2 font-semibold">
            <PartyPopperIcon className="size-4 text-success" /> You finished it!
          </p>
          <p className="text-sm text-muted-foreground">
            Everything you built is real in this lab: open it in the console or the terminal and explore.
          </p>
          {nextTutorial && (
            <Button size="sm" onClick={() => start(nextTutorial.id)}>
              Next: {nextTutorial.title} <ArrowRightIcon />
            </Button>
          )}
        </div>
      )}

      <ol className="space-y-2">
        {tutorial.steps.map((step, i) => {
          if (i === done && !finished) {
            return (
              <li key={step.id}>
                <CurrentStep step={step} index={i} />
              </li>
            );
          }
          const isDone = i < done;
          return (
            <li key={step.id} className={cn("flex items-start gap-2 px-1 text-sm", !isDone && "text-muted-foreground")}>
              {isDone ? (
                <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
              ) : (
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]">
                  {i + 1}
                </span>
              )}
              <span className={cn(isDone && "line-through decoration-muted-foreground/50")}>{step.title}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TutorialsTab() {
  const active = useGuideStore((s) => s.activeTutorial);
  return active ? <TutorialRunner id={active} /> : <TutorialList />;
}

// ---------- panel ----------

/** The "Guide me" side panel: full tutorials, or a smart hint about what to do next. */
export function GuidePanel() {
  const open = useGuideStore((s) => s.open);
  const setOpen = useGuideStore((s) => s.setOpen);
  const tab = useGuideStore((s) => s.tab);
  const setTab = useGuideStore((s) => s.setTab);
  const queryClient = useQueryClient();
  // Spins only for a manual refresh, not for the background polling.
  const [refreshing, setRefreshing] = useState(false);

  if (!open) return null;

  return (
    <aside
      aria-label="Guide"
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l bg-card shadow-xl sm:w-96 lg:static lg:z-auto lg:shadow-none"
    >
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4">
        <p className="flex items-center gap-2 font-semibold">
          <CompassIcon className="size-4 text-primary" /> Guide me
        </p>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh guide"
            onClick={async () => {
              setRefreshing(true);
              await queryClient.invalidateQueries({ queryKey: ["guide"] });
              setRefreshing(false);
            }}
          >
            <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close guide" onClick={() => setOpen(false)}>
            <XIcon />
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as GuideTab)} className="flex min-h-0 flex-1 flex-col">
        <div className="border-b px-4 py-3">
          <TabsList>
            <TabsTrigger value="tutorials">
              <BookOpenIcon /> Tutorials
            </TabsTrigger>
            <TabsTrigger value="next">
              <CompassIcon /> Next step
            </TabsTrigger>
          </TabsList>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <LastErrorCard />
          <TabsContent value="tutorials">
            <TutorialsTab />
          </TabsContent>
          <TabsContent value="next">
            <NextStepTab />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
