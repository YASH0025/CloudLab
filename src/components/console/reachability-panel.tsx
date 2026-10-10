"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2Icon, CircleDashedIcon, InfoIcon, RadarIcon, WrenchIcon, XCircleIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  reachabilityInput,
  type ReachabilityInput,
  type ReachabilityStep,
  type StepStatus,
} from "@/engine/analysis/reachability";
import { useReachability, useResources } from "@/hooks/use-cloud";
import { ApiError } from "@/lib/api-client";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type Mode = "internet" | "instance" | "outbound";

type Traffic = Pick<ReachabilityInput, "protocol" | "port">;

const PRESETS: Record<Mode, { label: string; value: Traffic }[]> = {
  internet: [
    { label: "HTTP", value: { protocol: "tcp", port: 80 } },
    { label: "HTTPS", value: { protocol: "tcp", port: 443 } },
    { label: "SSH", value: { protocol: "tcp", port: 22 } },
    { label: "Ping", value: { protocol: "icmp" } },
  ],
  instance: [
    { label: "SSH", value: { protocol: "tcp", port: 22 } },
    { label: "HTTP", value: { protocol: "tcp", port: 80 } },
    { label: "PostgreSQL", value: { protocol: "tcp", port: 5432 } },
    { label: "MySQL", value: { protocol: "tcp", port: 3306 } },
    { label: "Ping", value: { protocol: "icmp" } },
  ],
  outbound: [
    { label: "HTTPS (updates, APIs)", value: { protocol: "tcp", port: 443 } },
    { label: "HTTP", value: { protocol: "tcp", port: 80 } },
  ],
};

const MODES: { value: Mode; label: string; description: string }[] = [
  { value: "internet", label: "From the internet", description: "Can visitors on the internet reach this instance?" },
  { value: "instance", label: "From another instance", description: "Can another server in the VPC reach this one, e.g. a bastion host or a web server talking to a database?" },
  { value: "outbound", label: "Out to the internet", description: "Can this instance connect out, e.g. to download updates? Private servers need a NAT gateway for this." },
];

const statusIcon: Record<StepStatus, React.ReactNode> = {
  pass: <CheckCircle2Icon className="size-5 text-success" />,
  fail: <XCircleIcon className="size-5 text-destructive" />,
  skip: <CircleDashedIcon className="size-5 text-muted-foreground" />,
  info: <InfoIcon className="size-5 text-primary" />,
};

function Step({ step }: { step: ReachabilityStep }) {
  return (
    <li className="flex gap-3 py-3">
      <span className="mt-0.5 shrink-0">{statusIcon[step.status]}</span>
      <div className="min-w-0 space-y-1 text-sm">
        <p className={cn("font-medium", step.status === "skip" && "text-muted-foreground")}>
          {step.title}
          {step.resource && (
            <Link
              href={routes.detail(step.resource.service, step.resource.type, step.resource.id)}
              className="ml-2 font-mono text-xs font-normal text-primary hover:underline"
            >
              {step.resource.id}
            </Link>
          )}
        </p>
        <p className="text-muted-foreground">{step.detail}</p>
        {step.fix && (
          <p className="flex gap-2 rounded-md bg-warning/10 px-2.5 py-1.5">
            <WrenchIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>{step.fix}</span>
          </p>
        )}
      </div>
    </li>
  );
}

export function ReachabilityPanel({ instanceId }: { instanceId: string }) {
  const check = useReachability(instanceId);
  const [mode, setMode] = useState<Mode>("internet");
  const [from, setFrom] = useState<string>("");
  const { data: instances = [] } = useResources("compute", "instance");
  const others = instances.filter((i) => i.id !== instanceId && i.state !== "terminated");
  const form = useForm<ReachabilityInput>({
    resolver: zodResolver(reachabilityInput) as unknown as Resolver<ReachabilityInput>,
    defaultValues: { protocol: "tcp", port: 80, source: "0.0.0.0/0" },
  });
  const protocol = useWatch({ control: form.control, name: "protocol" });
  const errors = form.formState.errors;
  const result = check.data;
  const needsSource = mode === "instance" && !from;

  const request = (values: ReachabilityInput): ReachabilityInput => ({
    ...values,
    direction: mode === "outbound" ? "outbound" : "inbound",
    from: mode === "instance" ? from : "internet",
    source: mode === "instance" ? "0.0.0.0/0" : values.source,
  });
  const run = form.handleSubmit((values) => {
    if (!needsSource) check.mutate(request(values));
  });

  const switchMode = (next: Mode) => {
    setMode(next);
    check.reset();
    const preset = PRESETS[next][0].value;
    form.reset({ ...preset, source: "0.0.0.0/0" });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RadarIcon className="size-4 text-primary" /> Reachability check
        </CardTitle>
        <CardDescription>
          {MODES.find((m) => m.value === mode)!.description} Walks the route tables, gateways and security groups,
          and explains any break in the chain.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="What to check">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="tab"
              aria-selected={mode === m.value}
              onClick={() => switchMode(m.value)}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
                mode === m.value ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        {mode === "instance" && (
          <div className="space-y-1.5">
            <Label htmlFor="rc-from">Source instance</Label>
            {others.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                Launch another instance in this VPC to check traffic between them.
              </p>
            ) : (
              <Select value={from || undefined} onValueChange={setFrom}>
                <SelectTrigger id="rc-from">
                  <SelectValue placeholder="Choose the instance the traffic comes from" />
                </SelectTrigger>
                <SelectContent>
                  {others.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name && <span>{i.name}</span>}
                      <span className={cn("font-mono text-xs", i.name && "text-muted-foreground")}>
                        {i.id} · {String(i.attributes.privateIp ?? "")}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {PRESETS[mode].map((p) => (
            <Button
              key={p.label}
              type="button"
              variant="outline"
              size="sm"
              disabled={needsSource}
              onClick={() => {
                const values = { ...p.value, source: form.getValues("source") || "0.0.0.0/0" };
                form.reset(values);
                check.mutate(request(values));
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>

        <form
          onSubmit={run}
          className={cn(
            "grid gap-3 sm:items-start",
            mode === "instance" ? "sm:grid-cols-[8rem_7rem_max-content]" : "sm:grid-cols-[8rem_7rem_1fr_auto]",
          )}
          noValidate
        >
          <div className="space-y-1.5">
            <Label htmlFor="rc-protocol">Protocol</Label>
            <Controller
              control={form.control}
              name="protocol"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="rc-protocol">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">TCP</SelectItem>
                    <SelectItem value="udp">UDP</SelectItem>
                    <SelectItem value="icmp">ICMP</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rc-port">Port</Label>
            <Input
              id="rc-port"
              inputMode="numeric"
              disabled={protocol === "icmp"}
              aria-invalid={!!errors.port}
              {...form.register("port")}
            />
          </div>
          {mode !== "instance" && (
            <div className="space-y-1.5">
              <Label htmlFor="rc-source">{mode === "outbound" ? "Destination" : "Source"}</Label>
              <Input id="rc-source" className="font-mono" aria-invalid={!!errors.source} {...form.register("source")} />
            </div>
          )}
          <Button type="submit" disabled={check.isPending || needsSource} className="sm:mt-5">
            {check.isPending ? "Checking…" : "Check"}
          </Button>
          {(errors.port || errors.source) && (
            <p className="text-xs text-destructive sm:col-span-4">{errors.port?.message ?? errors.source?.message}</p>
          )}
        </form>

        {check.error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/8 p-3 text-sm">
            <span className="block font-mono text-xs font-semibold text-destructive">
              {check.error instanceof ApiError ? check.error.code : "Error"}
            </span>
            {check.error.message}
          </p>
        )}

        {result && !check.isPending && (
          <div className="space-y-2">
            <div
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
                result.reachable ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
              )}
            >
              {result.reachable ? <CheckCircle2Icon className="size-4 shrink-0" /> : <XCircleIcon className="size-4 shrink-0" />}
              {result.reachable ? "Reachable" : "Not reachable"}
              <span className="font-normal text-foreground">— {result.summary}</span>
            </div>
            <ol className="divide-y">
              {result.steps.map((s) => (
                <Step key={s.id} step={s} />
              ))}
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
