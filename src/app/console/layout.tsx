import { Suspense } from "react";
import { ChallengeBanner } from "@/components/console/challenge-panel";
import { GuidePanel } from "@/components/console/guide-panel";
import { ProgressSync } from "@/components/console/progress-sync";
import { ServiceCatalogProvider } from "@/components/console/service-catalog";
import { Sidebar } from "@/components/console/sidebar";
import { Topbar } from "@/components/console/topbar";
import { Skeleton } from "@/components/ui/skeleton";
import { serviceCatalog } from "@/engine/registry";

// The console reads the URL (current service, resource ID) on the client, so its
// parts stream in behind Suspense boundaries while the shell is prerendered.
// The service definitions travel as data (serviceCatalog); the engine's code stays on the server.
export default function ConsoleLayout({ children }: LayoutProps<"/console">) {
  return (
    <ServiceCatalogProvider catalog={serviceCatalog()}>
      <div className="flex h-dvh overflow-hidden">
        <Suspense fallback={<div className="hidden w-60 shrink-0 bg-sidebar md:block" />}>
          <Sidebar />
        </Suspense>
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <ChallengeBanner />
          {/* relative + min-h-0: hidden form controls (Radix checkboxes, selects) are positioned inside the
              scroll area instead of stretching the whole page and adding a second scrollbar. */}
          <main className="relative min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-6">
              <Suspense fallback={<Skeleton className="h-64" />}>{children}</Suspense>
            </div>
          </main>
        </div>
        <GuidePanel />
        <ProgressSync />
      </div>
    </ServiceCatalogProvider>
  );
}
