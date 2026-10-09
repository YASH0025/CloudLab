import { Suspense } from "react";
import { GuidePanel } from "@/components/console/guide-panel";
import { Sidebar } from "@/components/console/sidebar";
import { Topbar } from "@/components/console/topbar";
import { Skeleton } from "@/components/ui/skeleton";

// The console reads the URL (current service, resource ID) on the client, so its
// parts stream in behind Suspense boundaries while the shell is prerendered.
export default function ConsoleLayout({ children }: LayoutProps<"/console">) {
  return (
    <div className="flex h-dvh overflow-hidden">
      <Suspense fallback={<div className="hidden w-60 shrink-0 bg-sidebar md:block" />}>
        <Sidebar />
      </Suspense>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-6">
            <Suspense fallback={<Skeleton className="h-64" />}>{children}</Suspense>
          </div>
        </main>
      </div>
      <GuidePanel />
    </div>
  );
}
