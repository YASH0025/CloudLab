"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { ActivityIcon, GaugeIcon, Loader2Icon, SendIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { TargetHealth, TargetState } from "@/engine/analysis/health";
import type { ResourceDTO } from "@/engine/types";
import { useResources, useTargetHealth, useTestRequests, useUpdateResource } from "@/hooks/use-cloud";
import { ApiError } from "@/lib/api-client";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { Step } from "./reachability-panel";
import { StateBadge } from "./state-badge";

// ---------- target health ----------

const HEALTH_VARIANT: Record<TargetState, "success" | "destructive" | "warning" | "secondary"> = {
  healthy: "success",
  unhealthy: "destructive",
  initial: "warning",
  unused: "secondary",
};

/** What each reason code means, in plain words. */
const REASON_HELP: Record<string, (port: number) => string> = {
  "Elb.RegistrationInProgress": () => "The instance is still starting. Health checks begin once it's running.",
  "Elb.InitialHealthChecking": () => "Health checks have started. A target must pass a few in a row before it gets traffic (about 10 seconds in CloudLab).",
  "Target.Timeout": (port) =>
    `The health check got no answer on port ${port}. Almost always the instance's security group doesn't allow port ${port} from the load balancer's security group.`,
  "Target.InvalidState": () => "The instance is stopped or terminated, so it can't serve traffic.",
  "Target.NotInUse": () => "No load balancer sends traffic here: add a listener that forwards to this target group, or enable the instance's zone on the load balancer.",
};

function HealthBadge({ state }: { state: TargetState }) {
  return (
    <Badge variant={HEALTH_VARIANT[state]}>
      <span className="size-1.5 rounded-full bg-current" />
      {state}
    </Badge>
  );
}

function HealthTable({ targets }: { targets: TargetHealth[] }) {
  if (targets.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">No targets registered. Add instances in “Edit settings” below, or attach this target group to an Auto Scaling group.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Instance</TableHead>
            <TableHead>Port</TableHead>
            <TableHead>Zone</TableHead>
            <TableHead>Health</TableHead>
            <TableHead>Why</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {targets.map((t) => (
            <TableRow key={t.id}>
              <TableCell>
                <Link href={routes.detail("compute", "instance", t.id)} className="font-mono text-xs text-primary hover:underline">
                  {t.id}
                </Link>
              </TableCell>
              <TableCell>{t.port}</TableCell>
              <TableCell>{t.availabilityZone ?? "–"}</TableCell>
              <TableCell>
                <HealthBadge state={t.state} />
              </TableCell>
              <TableCell className="max-w-md text-xs whitespace-normal">
                {t.reason ? (
                  <>
                    <span className="font-mono">{t.reason}</span>
                    <span className="block text-muted-foreground">{REASON_HELP[t.reason]?.(t.port) ?? t.description}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Passing health checks</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function TargetHealthPanel({ targetGroup }: { targetGroup: ResourceDTO }) {
  const health = useTargetHealth(targetGroup.id);
  const targets = health.data ?? [];
  const healthy = targets.filter((t) => t.state === "healthy").length;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ActivityIcon className="size-4" /> Target health
        </CardTitle>
        <CardDescription>
          The load balancer requests <span className="font-mono">{String(targetGroup.config.healthCheckPath ?? "/")}</span> on port{" "}
          {String(targetGroup.config.port)} of each target. Only healthy targets get traffic.
          {targets.length > 0 && ` ${healthy} of ${targets.length} healthy.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="py-2 pb-5">
        {health.error ? (
          <p className="text-sm text-destructive">{health.error.message}</p>
        ) : health.isLoading ? (
          <p className="py-3 text-sm text-muted-foreground">Checking targets…</p>
        ) : (
          <HealthTable targets={targets} />
        )}
      </CardContent>
    </Card>
  );
}

// ---------- load balancer: send requests ----------

export function LoadBalancerPanel({ lb }: { lb: ResourceDTO }) {
  const test = useTestRequests(lb.id);
  const listeners = (lb.config.listeners as { port: number }[] | undefined) ?? [];
  const ports = [...new Set([...listeners.map((l) => Number(l.port)), 80])];
  const [port, setPort] = useState<number>(Number(listeners[0]?.port ?? 80));
  const result = test.data;
  const host = String(lb.attributes.dnsName ?? "");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SendIcon className="size-4" /> Send requests
        </CardTitle>
        <CardDescription>
          Visit the load balancer like someone on the internet would. CloudLab follows each request through DNS, the security group, the listener and the target
          group, and shows which server answered.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 py-2 pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs">
            curl http://{host}
            {port === 80 ? "" : `:${port}`}/
          </code>
          {ports.length > 1 &&
            ports.map((p) => (
              <Button key={p} size="sm" variant={p === port ? "secondary" : "ghost"} onClick={() => setPort(p)}>
                Port {p}
              </Button>
            ))}
          <Button size="sm" onClick={() => test.mutate({ port, count: 6 })} disabled={test.isPending}>
            {test.isPending ? <Loader2Icon className="animate-spin" /> : <SendIcon />} Send 6 requests
          </Button>
        </div>

        {test.error && (
          <p className="text-sm text-destructive">
            {test.error instanceof ApiError ? `${test.error.code}: ` : ""}
            {test.error.message}
          </p>
        )}

        {result && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <p className={cn("text-sm font-medium", result.ok ? "text-success" : "text-destructive")}>{result.summary}</p>
              <ol className="divide-y">
                {result.steps.map((s) => (
                  <Step key={s.id} step={s} />
                ))}
              </ol>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Responses</p>
              <ol className="space-y-1.5 font-mono text-xs">
                {result.responses.map((r) => (
                  <li key={r.n} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md bg-muted/60 px-2.5 py-1.5">
                    <span className="text-muted-foreground">#{r.n}</span>
                    <span className={cn("font-semibold", r.status === 200 ? "text-success" : "text-destructive")}>
                      {r.status ? `${r.status} ${r.statusText}` : r.statusText}
                    </span>
                    {r.targetId && (
                      <span>
                        from{" "}
                        <Link href={routes.detail("compute", "instance", r.targetId)} className="text-primary hover:underline">
                          {r.targetId}
                        </Link>{" "}
                        <span className="text-muted-foreground">({r.availabilityZone})</span>
                      </span>
                    )}
                    {r.status !== null && <span className="ml-auto text-muted-foreground">{r.ms} ms</span>}
                  </li>
                ))}
              </ol>
              {result.ok && (
                <p className="text-xs text-muted-foreground">
                  Each request goes to the next healthy server in turn (round robin). Stop one of them and send again: the others keep answering.
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Auto Scaling group ----------

interface Activity {
  at: string;
  description: string;
  cause: string;
  status: "Successful" | "Failed";
}

const TRAFFIC = [
  { value: "idle", label: "Idle" },
  { value: "normal", label: "Normal" },
  { value: "busy", label: "Busy" },
  { value: "spike", label: "Spike" },
];

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function AutoScalingPanel({ group }: { group: ResourceDTO }) {
  const instances = useResources("compute", "instance", { live: true });
  const update = useUpdateResource(group.id);
  const members = (instances.data ?? []).filter(
    (i) => (i.attributes.system as { managedBy?: string } | undefined)?.managedBy === group.id && i.state !== "terminated",
  );
  const activities = (group.attributes.activities as Activity[] | undefined) ?? [];
  const cpu = Number(group.attributes.averageCpu ?? 0);
  const target = group.config.targetCpu ? Number(group.config.targetCpu) : null;
  const traffic = String(group.config.simulatedTraffic ?? "normal");

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GaugeIcon className="size-4" /> Capacity and load
          </CardTitle>
          <CardDescription>
            The group keeps <strong>desired</strong> instances running, between the minimum and maximum.
            {target ? ` Its target tracking policy aims for ${target}% average CPU: it adds instances when CPU is above that and removes them (after a short cooldown) when it's well below.` : " Add a CPU target in “Edit settings” to let it grow and shrink with load."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 py-2 pb-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Instances" value={String(group.attributes.instanceCount ?? members.length)} />
            <Stat label="Desired" value={String(group.config.desiredCapacity)} />
            <Stat label="Min" value={String(group.config.minSize)} />
            <Stat label="Max" value={String(group.config.maxSize)} />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between text-sm">
              <span>Average CPU</span>
              <span className="font-mono tabular-nums">
                {cpu}%{target ? <span className="text-muted-foreground"> / target {target}%</span> : null}
              </span>
            </div>
            <div className="relative h-2.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full transition-all", target && cpu > target ? "bg-destructive" : "bg-success")}
                style={{ width: `${Math.min(cpu, 100)}%` }}
              />
              {target && <div className="absolute inset-y-0 w-0.5 bg-foreground/70" style={{ left: `${target}%` }} title={`Target ${target}%`} />}
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-sm">
              Simulated traffic <span className="text-xs text-muted-foreground">(CloudLab only: turn the load up and watch the group react)</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {TRAFFIC.map((t) => (
                <Button
                  key={t.value}
                  size="sm"
                  variant={t.value === traffic ? "secondary" : "outline"}
                  disabled={update.isPending}
                  onClick={() => t.value !== traffic && update.mutate({ simulatedTraffic: t.value })}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Instance</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Launched</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-sm text-muted-foreground">
                      No instances yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  members.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell>
                        <Link href={routes.detail("compute", "instance", i.id)} className="font-mono text-xs text-primary hover:underline">
                          {i.id}
                        </Link>
                      </TableCell>
                      <TableCell>{String(i.attributes.availabilityZone ?? "–")}</TableCell>
                      <TableCell>
                        <StateBadge state={i.state} pending={i.pendingState} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDistanceToNowStrict(new Date(i.createdAt), { addSuffix: true })}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Activity history</CardTitle>
          <CardDescription>Everything the group did and why, newest first. The same list as aws autoscaling describe-scaling-activities.</CardDescription>
        </CardHeader>
        <CardContent className="py-2 pb-5">
          {activities.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ol className="divide-y">
              {activities.map((a, idx) => (
                <li key={`${a.at}-${idx}`} className="space-y-0.5 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={a.status === "Successful" ? "success" : "destructive"}>{a.status}</Badge>
                    <span className="font-medium">{a.description}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{formatDistanceToNowStrict(new Date(a.at), { addSuffix: true })}</span>
                  </div>
                  <p className="text-muted-foreground">Cause: {a.cause.charAt(0).toUpperCase() + a.cause.slice(1)}</p>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </>
  );
}
