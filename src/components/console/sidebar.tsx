"use client";

import { BoxIcon, DatabaseIcon, LayoutDashboardIcon, NetworkIcon, ServerIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { site } from "@/config/site";
import { useServices } from "@/hooks/use-cloud";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

const icons: Record<string, ComponentType<{ className?: string }>> = {
  Networking: NetworkIcon,
  Compute: ServerIcon,
  Storage: DatabaseIcon,
};

export function Sidebar() {
  const pathname = usePathname();
  const { data, isLoading } = useServices();

  return (
    <aside className="hidden w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      <Link href="/" className="flex h-14 items-center gap-2 border-b border-white/10 px-4 font-semibold">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <BoxIcon className="size-4" />
        </span>
        {site.name}
      </Link>
      <nav className="flex-1 overflow-y-auto px-2 py-3 text-sm">
        <Link
          href={routes.console()}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent",
            pathname === routes.console() && "bg-sidebar-accent text-white",
          )}
        >
          <LayoutDashboardIcon className="size-4" />
          Dashboard
        </Link>
        {isLoading &&
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="mx-2 mt-5 h-16 bg-sidebar-accent" />)}
        {data?.services.map((service) => {
          const Icon = icons[service.category] ?? BoxIcon;
          return (
            <div key={service.id} className="mt-5">
              <div className="flex items-center gap-2 px-2 pb-1 text-xs font-medium tracking-wide text-sidebar-muted uppercase">
                <Icon className="size-3.5" />
                {service.label}
                <span className="ml-auto font-normal normal-case opacity-70">{service.modelledOn}</span>
              </div>
              {service.types.map((t) => {
                const href = routes.list(service.id, t.type);
                const active = pathname.startsWith(href);
                return (
                  <Link
                    key={t.type}
                    href={href}
                    className={cn(
                      "block rounded-md px-2 py-1.5 pl-7 hover:bg-sidebar-accent",
                      active && "bg-sidebar-accent text-white",
                    )}
                  >
                    {t.pluralLabel}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
      <p className="border-t border-white/10 px-4 py-3 text-xs text-sidebar-muted">
        Everything here is simulated. Nothing is billed.
      </p>
    </aside>
  );
}
