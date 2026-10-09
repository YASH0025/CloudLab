"use client";

import { GlobeIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useServices } from "@/hooks/use-cloud";
import { useConsoleStore } from "@/stores/console-store";

export function Topbar() {
  const { region, setRegion } = useConsoleStore();
  const { data } = useServices();
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <header className="flex h-14 items-center justify-end gap-2 border-b bg-card px-4">
      <div className="flex items-center gap-2">
        <GlobeIcon className="size-4 text-muted-foreground" />
        <Select value={region} onValueChange={setRegion}>
          <SelectTrigger className="h-8 w-60" aria-label="Region">
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
