"use client";

import {
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  CompassIcon,
  Loader2Icon,
  RefreshCwIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { explainError } from "@/guide/errors";
import type { GuideLink, Level, Suggestion } from "@/guide/types";
import { useGuide } from "@/hooks/use-cloud";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { useGuideStore } from "@/stores/guide-store";

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

function SuggestionBody({ s }: { s: Suggestion }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{s.why}</p>
      <ol className="space-y-1.5 text-sm">
        {s.steps.map((step, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {!s.waiting && (s.link || s.cli) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {s.link && (
            <Button asChild size="sm">
              <Link href={hrefFor(s.link)}>
                Take me there <ArrowRightIcon />
              </Link>
            </Button>
          )}
          {s.cli && (
            <Button asChild size="sm" variant="outline">
              <Link href={routes.terminalWith(s.cli)}>
                <SquareTerminalIcon /> Do it in the terminal
              </Link>
            </Button>
          )}
        </div>
      )}
      {s.cli && (
        <pre className="overflow-x-auto rounded-md bg-muted px-2.5 py-2 font-mono text-xs whitespace-pre-wrap break-all">
          {s.cli}
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

/** The "What's next?" side panel. */
export function GuidePanel() {
  const open = useGuideStore((s) => s.open);
  const setOpen = useGuideStore((s) => s.setOpen);
  const guide = useGuide(open);

  if (!open) return null;
  const advice = guide.data;
  const done = advice?.milestones.filter((m) => m.done).length ?? 0;
  const total = advice?.milestones.length ?? 0;

  return (
    <aside
      aria-label="Guide"
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l bg-card shadow-xl sm:w-96 lg:static lg:z-auto lg:shadow-none"
    >
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4">
        <p className="flex items-center gap-2 font-semibold">
          <CompassIcon className="size-4 text-primary" /> What&apos;s next?
          {advice && <Badge variant="secondary">{levelLabel[advice.level]}</Badge>}
        </p>
        <div className="flex items-center">
          <Button variant="ghost" size="icon" aria-label="Refresh guide" onClick={() => guide.refetch()}>
            <RefreshCwIcon className={cn(guide.isFetching && "animate-spin")} />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close guide" onClick={() => setOpen(false)}>
            <XIcon />
          </Button>
        </div>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <LastErrorCard />

        {guide.isLoading && <Skeleton className="h-64" />}
        {guide.isError && <p className="text-sm text-destructive">Couldn&apos;t load the guide. Try refreshing.</p>}

        {advice && (
          <>
            <section className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
              <p className="text-xs font-medium tracking-wide text-primary uppercase">Next step</p>
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
                    {m.done ? (
                      <CheckCircle2Icon className="size-4 text-success" />
                    ) : (
                      <CircleIcon className="size-4" />
                    )}
                    {m.label}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
