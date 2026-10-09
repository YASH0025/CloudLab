"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2Icon, CircleDashedIcon, InfoIcon, RadarIcon, WrenchIcon, XCircleIcon } from "lucide-react";
import Link from "next/link";
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
import { useReachability } from "@/hooks/use-cloud";
import { ApiError } from "@/lib/api-client";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

const presets: { label: string; value: ReachabilityInput }[] = [
  { label: "HTTP", value: { protocol: "tcp", port: 80, source: "0.0.0.0/0" } },
  { label: "HTTPS", value: { protocol: "tcp", port: 443, source: "0.0.0.0/0" } },
  { label: "SSH", value: { protocol: "tcp", port: 22, source: "0.0.0.0/0" } },
  { label: "Ping", value: { protocol: "icmp", source: "0.0.0.0/0" } },
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
  const form = useForm<ReachabilityInput>({
    resolver: zodResolver(reachabilityInput) as unknown as Resolver<ReachabilityInput>,
    defaultValues: presets[0].value,
  });
  const protocol = useWatch({ control: form.control, name: "protocol" });
  const errors = form.formState.errors;
  const result = check.data;

  const run = form.handleSubmit((values) => check.mutate(values));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RadarIcon className="size-4 text-primary" /> Reachability check
        </CardTitle>
        <CardDescription>
          Can traffic from the internet reach this instance? Walks the route table, internet gateway and security
          groups, and explains any break in the chain.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Button
              key={p.label}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                form.reset(p.value);
                check.mutate(p.value);
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>

        <form onSubmit={run} className="grid gap-3 sm:grid-cols-[8rem_7rem_1fr_auto] sm:items-end" noValidate>
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
          <div className="space-y-1.5">
            <Label htmlFor="rc-source">Source</Label>
            <Input id="rc-source" className="font-mono" aria-invalid={!!errors.source} {...form.register("source")} />
          </div>
          <Button type="submit" disabled={check.isPending}>
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
              {result.reachable ? <CheckCircle2Icon className="size-4" /> : <XCircleIcon className="size-4" />}
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
