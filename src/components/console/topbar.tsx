"use client";

import { CompassIcon, GlobeIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useServices } from "@/hooks/use-cloud";
import { useConsoleStore } from "@/stores/console-store";
import { useGuideStore } from "@/stores/guide-store";
import { MobileNav } from "./sidebar";

export function Topbar() {
  const { region, setRegion } = useConsoleStore();
  const { data } = useServices();
  const { resolvedTheme, setTheme } = useTheme();
  const guideOpen = useGuideStore((s) => s.open);
  const toggleGuide = useGuideStore((s) => s.toggle);

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-3 sm:px-4">
      {/* The menu reads the current URL, so it streams in after the shell. */}
      <Suspense fallback={<span className="size-9 md:hidden" />}>
        <MobileNav />
      </Suspense>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <GlobeIcon className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
        <Select value={region} onValueChange={setRegion}>
          <SelectTrigger className="h-8 w-36 sm:w-60" aria-label="Region">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(data?.regions ?? [{ code: region, name: region }]).map((r) => (
              <SelectItem key={r.code} value={r.code}>
                {r.name} <span className="text-muted-foreground">{r.code}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        variant={guideOpen ? "secondary" : "default"}
        size="sm"
        onClick={toggleGuide}
        aria-pressed={guideOpen}
        aria-label="Guide me"
      >
        <CompassIcon /> <span className="hidden sm:inline">Guide me</span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Toggle theme"
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      >
        <SunIcon className="hidden dark:block" />
        <MoonIcon className="dark:hidden" />
      </Button>
    </header>
  );
}
