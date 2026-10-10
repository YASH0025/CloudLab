"use client";

import { CheckCircle2Icon, KeyRoundIcon, XCircleIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSimulate } from "@/hooks/use-cloud";
import { ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/** Common actions to try, so learners don't have to know the names yet. */
const PRESETS: { label: string; action: string; resource: string }[] = [
  { label: "List instances", action: "ec2:DescribeInstances", resource: "*" },
  { label: "Launch an instance", action: "ec2:RunInstances", resource: "*" },
  { label: "Create a VPC", action: "ec2:CreateVpc", resource: "*" },
  { label: "List buckets", action: "s3:ListAllMyBuckets", resource: "*" },
  { label: "Read a file", action: "s3:GetObject", resource: "arn:aws:s3:::my-bucket/report.pdf" },
  { label: "Upload a file", action: "s3:PutObject", resource: "arn:aws:s3:::my-bucket/report.pdf" },
  { label: "Create a user", action: "iam:CreateUser", resource: "*" },
];

const DECISION = {
  allowed: { label: "Allowed", ok: true },
  explicitDeny: { label: "Denied by an explicit Deny", ok: false },
  implicitDeny: { label: "Denied: no policy allows it", ok: false },
} as const;

/**
 * IAM's policy simulator: would this user, group or role be allowed to do
 * something, and which policy statement decided it?
 */
export function PermissionChecker({ kind, name }: { kind: "user" | "group" | "role"; name: string }) {
  const [action, setAction] = useState("s3:ListAllMyBuckets");
  const [resource, setResource] = useState("*");
  const sim = useSimulate();
  const run = (a = action, r = resource) => sim.mutate({ kind, name, action: a, resource: r });
  const res = sim.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-4 text-primary" /> Check permissions
        </CardTitle>
        <CardDescription>
          Would this {kind} be allowed to do something? Pick an action, or type any, like s3:GetObject. The answer
          shows which policy statement decided it. An explicit Deny always wins; with no Allow, the answer is no.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setAction(p.action);
                setResource(p.resource);
                run(p.action, p.resource);
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="pc-action">Action</Label>
            <Input id="pc-action" className="font-mono" value={action} onChange={(e) => setAction(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pc-resource">Resource ARN</Label>
            <Input id="pc-resource" className="font-mono" value={resource} onChange={(e) => setResource(e.target.value)} />
          </div>
          <Button type="submit" disabled={sim.isPending}>
            {sim.isPending ? "Checking…" : "Check"}
          </Button>
        </form>

        {sim.error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/8 p-3 text-sm">
            <span className="block font-mono text-xs font-semibold text-destructive">{sim.error instanceof ApiError ? sim.error.code : "Error"}</span>
            {sim.error.message}
          </p>
        )}

        {res && !sim.isPending && (
          <div className="space-y-3">
            <div
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
                DECISION[res.result.decision].ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
              )}
            >
              {DECISION[res.result.decision].ok ? <CheckCircle2Icon className="size-4" /> : <XCircleIcon className="size-4" />}
              {DECISION[res.result.decision].label}
              <span className="font-mono text-xs font-normal text-foreground">
                {res.result.action} on {res.result.resource}
              </span>
            </div>
            {res.result.matched.length > 0 && (
              <div className="text-sm">
                <p className="mb-1 text-muted-foreground">Decided by:</p>
                <ul className="space-y-1">
                  {res.result.matched.map((m, i) => (
                    <li key={i}>
                      <span className={m.effect === "Deny" ? "text-destructive" : "text-success"}>{m.effect}</span> in{" "}
                      <span className="font-medium">{m.policy}</span> ({m.via}), statement {m.sid ? `"${m.sid}"` : `#${m.index + 1}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {res.result.skippedConditions.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {res.result.skippedConditions.length} statement(s) with a Condition were skipped: CloudLab doesn&apos;t evaluate conditions yet.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {res.policies.length === 0
                ? `No policies apply to this ${kind}, so everything is denied.`
                : `Policies that apply: ${res.policies.map((p) => `${p.name} (${p.via})`).join(", ")}.`}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
