"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  BoxIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
  MenuIcon,
  NetworkIcon,
  ServerIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType } from "react";
import { Button } from "@/components/ui/button";
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

/** The navigation itself, shared by the desktop sidebar and the mobile menu. */
function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { data, isLoading } = useServices();

  return (
    <>
      <Link
        href="/"
        onClick={onNavigate}
        className="flex h-14 shrink-0 items-center gap-2 border-b border-white/10 px-4 font-semibold"
      >
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <BoxIcon className="size-4" />
        </span>
        {site.name}
      </Link>
      <nav className="relative min-h-0 flex-1 overflow-y-auto px-2 py-3 text-sm" onClick={(e) => (e.target as HTMLElement).closest("a") && onNavigate?.()}>
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
        <Link
          href={routes.terminal()}
          className={cn(
            "mt-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent",
            pathname === routes.terminal() && "bg-sidebar-accent text-white",
          )}
        >
          <TerminalIcon className="size-4" />
          Terminal
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
    </>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      <SidebarContent />
    </aside>
  );
}

/** On small screens the sidebar becomes a slide-in menu opened from the top bar. */
export function MobileNav() {
  // Closed by SidebarContent's onNavigate whenever a link is followed.
  const [open, setOpen] = useState(false);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
          <MenuIcon />
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 md:hidden" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar text-sidebar-foreground shadow-xl data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left md:hidden"
        >
          <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
          <DialogPrimitive.Close
            className="absolute top-4 right-3 rounded-sm p-0.5 opacity-70 hover:opacity-100"
            aria-label="Close menu"
          >
            <XIcon className="size-4" />
          </DialogPrimitive.Close>
          <SidebarContent onNavigate={() => setOpen(false)} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
