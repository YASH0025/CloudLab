"use client";

import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useResources, useServices } from "@/hooks/use-cloud";
import { routes } from "@/lib/routes";
import { useConsoleStore } from "@/stores/console-store";

const steps = [
  { label: "Create a VPC", href: routes.create("networking", "vpc") },
  { label: "Add a subnet inside it", href: routes.create("networking", "subnet") },
  { label: "Create an internet gateway and attach it to the VPC", href: routes.create("networking", "internet-gateway") },
  { label: "Create a route table: 0.0.0.0/0 → gateway, associate the subnet", href: routes.create("networking", "route-table") },
  { label: "Create a security group that allows HTTP", href: routes.create("networking", "security-group") },
  { label: "Launch an instance with a public IP", href: routes.create("compute", "instance") },
  { label: "Open the instance and run a reachability check", href: routes.list("compute", "instance") },
  { label: "Create a bucket for static assets", href: routes.create("storage", "bucket") },
];

export function DashboardView() {
  const region = useConsoleStore((s) => s.region);
  const services = useServices();
  const all = useResources();

  const count = (service: string, type: string) =>
    (all.data ?? []).filter((r) => r.service === service && r.type === type && r.state !== "terminated").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Console</h1>
        <p className="text-sm text-muted-foreground">
          Resources in <span className="font-mono">{region}</span>. Everything is simulated; nothing is billed.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {services.isLoading &&
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40" />)}
        {services.data?.services.map((s) => (
          <Card key={s.id}>
            <CardHeader>
              <CardTitle>
                {s.label} <span className="font-normal text-muted-foreground">· {s.modelledOn}</span>
              </CardTitle>
              <CardDescription>{s.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 py-3">
              {s.types.map((t) => (
                <Link
                  key={t.type}
                  href={routes.list(s.id, t.type)}
                  className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  {t.pluralLabel}
                  <span className="font-mono text-muted-foreground">{all.isLoading ? "…" : count(s.id, t.type)}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Get started: deploy a web server</CardTitle>
          <CardDescription>The classic first build. Each step links to the right form.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-1">
            {steps.map((step, i) => (
              <li key={step.href}>
                <Link
                  href={step.href}
                  className="group flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"
                >
                  <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {i + 1}
                  </span>
                  {step.label}
                  <ArrowRightIcon className="ml-auto size-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
