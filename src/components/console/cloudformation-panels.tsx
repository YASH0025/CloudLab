"use client";

import { format } from "date-fns";
import { Loader2Icon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PlannedChange, StackEvent, StackOutput, StackResource } from "@/engine/cloudformation/deploy";
import type { ResourceDTO } from "@/engine/types";
import { usePreviewChanges, useUpdateResource } from "@/hooks/use-cloud";
import { ApiError } from "@/lib/api-client";
import { routes } from "@/lib/routes";
import { StateBadge } from "./state-badge";

const time = (iso: string) => format(new Date(iso), "yyyy-MM-dd HH:mm:ss");

function ErrorLine({ error }: { error: unknown }) {
  if (!(error instanceof ApiError)) return null;
  return (
    <p className="text-sm text-destructive" role="alert">
      <span className="font-mono">{error.code}</span>: {error.message}
    </p>
  );
}

function PhysicalId({ r }: { r: StackResource }) {
  if (r.resourceId && r.service && r.consoleType) {
    return (
      <Link href={routes.detail(r.service, r.consoleType, r.resourceId)} className="block max-w-72 truncate font-mono text-xs text-primary hover:underline" title={r.physicalId}>
        {r.physicalId}
      </Link>
    );
  }
  return (
    <span className="block max-w-72 truncate font-mono text-xs" title={r.physicalId}>
      {r.physicalId}
    </span>
  );
}

/** A stack's page: events (what happened, newest first), the resources it made, outputs and parameters. */
export function StackPanel({ stack }: { stack: ResourceDTO }) {
  const events = (stack.attributes.events as StackEvent[] | undefined) ?? [];
  const resources = (stack.attributes.resources as StackResource[] | undefined) ?? [];
  const outputs = (stack.attributes.outputs as StackOutput[] | undefined) ?? [];
  const params = (stack.attributes.parametersResolved as Record<string, string> | undefined) ?? {};
  const failure = events.find((e) => /FAILED$/.test(e.status) && e.logicalId !== stack.name);
  const reason = events.find((e) => e.logicalId === stack.name && e.reason && e.status !== "CREATE_IN_PROGRESS" && e.status !== "UPDATE_IN_PROGRESS");
  const bad = /ROLLBACK|FAILED/.test(String(stack.state));

  return (
    <>
      {bad && (failure || reason) && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Why it failed</CardTitle>
            <CardDescription>The first resource that failed, and what the service said. Everything else was rolled back.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 pb-5 text-sm">
            {failure && (
              <p>
                <span className="font-mono">{failure.logicalId}</span> ({failure.type}): <span className="text-destructive">{failure.reason}</span>
              </p>
            )}
            {reason?.reason && <p className="text-muted-foreground">{reason.reason}</p>}
            <p className="text-muted-foreground">
              {stack.state === "ROLLBACK_COMPLETE"
                ? "A stack that failed to create can't be updated: fix the template, delete this stack and create it again."
                : "Fix the template and update the stack again."}
            </p>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent className="py-5">
          <Tabs defaultValue={bad ? "events" : "resources"}>
            <TabsList>
              <TabsTrigger value="events">Events ({events.length})</TabsTrigger>
              <TabsTrigger value="resources">Resources ({resources.length})</TabsTrigger>
              <TabsTrigger value="outputs">Outputs ({outputs.length})</TabsTrigger>
              <TabsTrigger value="parameters">Parameters ({Object.keys(params).length})</TabsTrigger>
            </TabsList>
            <TabsContent value="events" className="pt-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Logical ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Status reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">{time(e.timestamp)}</TableCell>
                      <TableCell className="text-xs">
                        <span className="font-mono">{e.logicalId}</span>
                        <span className="block text-[11px] text-muted-foreground">{e.type}</span>
                      </TableCell>
                      <TableCell>
                        <StateBadge state={e.status} />
                      </TableCell>
                      <TableCell className="min-w-56 text-xs whitespace-normal text-muted-foreground">{e.reason ?? ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="resources" className="pt-3">
              {resources.length === 0 ? (
                <p className="text-sm text-muted-foreground">No resources.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Logical ID</TableHead>
                      <TableHead>Physical ID</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {resources.map((r) => (
                      <TableRow key={r.logicalId}>
                        <TableCell className="font-mono text-xs">{r.logicalId}</TableCell>
                        <TableCell>
                          <PhysicalId r={r} />
                        </TableCell>
                        <TableCell className="text-xs">{r.type}</TableCell>
                        <TableCell>
                          <StateBadge state={r.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>
            <TabsContent value="outputs" className="pt-3">
              {outputs.length === 0 ? (
                <p className="text-sm text-muted-foreground">The template has no Outputs (values to show or share with other stacks, like a URL or an ID).</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Key</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead>Export name</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {outputs.map((o) => (
                      <TableRow key={o.key}>
                        <TableCell className="text-xs">
                          <span className="font-mono">{o.key}</span>
                          {o.description && <span className="block text-[11px] text-muted-foreground">{o.description}</span>}
                        </TableCell>
                        <TableCell className="max-w-80 font-mono text-xs break-all whitespace-normal">{o.value}</TableCell>
                        <TableCell className="font-mono text-xs">{o.exportName ?? ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>
            <TabsContent value="parameters" className="pt-3">
              {Object.keys(params).length === 0 ? (
                <p className="text-sm text-muted-foreground">No parameters.</p>
              ) : (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-sm">
                  {Object.entries(params).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="font-mono text-xs">{k}</dt>
                      <dd className="font-mono text-xs break-all">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      {!/IN_PROGRESS|^ROLLBACK_COMPLETE$|^CREATE_FAILED$/.test(String(stack.state)) && <UpdateCard stack={stack} />}
    </>
  );
}

const ACTION: Record<PlannedChange["action"], "success" | "warning" | "destructive"> = { Add: "success", Modify: "warning", Remove: "destructive" };

/** Update with a preview first, like a change set: what's added, modified (replaced?) and removed. */
function UpdateCard({ stack }: { stack: ResourceDTO }) {
  const [template, setTemplate] = useState(String(stack.config.templateBody ?? ""));
  const current = (stack.config.parameters as { key: string; value?: string }[] | undefined) ?? [];
  const resolved = (stack.attributes.parametersResolved as Record<string, string> | undefined) ?? {};
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...resolved, ...Object.fromEntries(current.map((p) => [p.key, p.value ?? ""])) }));
  const preview = usePreviewChanges(stack.id);
  const update = useUpdateResource(stack.id);
  const parameters = Object.entries(values).map(([key, value]) => ({ key, value }));
  const changes = preview.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Update stack</CardTitle>
        <CardDescription>
          Edit the template or parameters, preview what would change (a change set), then apply. Watch the Replacement column: a replaced resource is deleted and created again, with a new ID.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pb-5">
        <textarea
          aria-label="Template"
          spellCheck={false}
          className="min-h-72 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={template}
          onChange={(e) => {
            setTemplate(e.target.value);
            preview.reset();
          }}
        />
        {Object.keys(values).length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
            {Object.entries(values).map(([k, v]) => (
              <div key={k} className="space-y-1.5">
                <Label htmlFor={`param-${k}`} className="font-mono text-xs">
                  {k}
                </Label>
                <Input
                  id={`param-${k}`}
                  value={v}
                  onChange={(e) => {
                    setValues({ ...values, [k]: e.target.value });
                    preview.reset();
                  }}
                />
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={preview.isPending} onClick={() => preview.mutate({ templateBody: template, parameters })}>
            {preview.isPending ? <Loader2Icon className="animate-spin" /> : <SearchIcon />} Preview changes
          </Button>
          <Button
            disabled={!changes || changes.length === 0 || update.isPending}
            onClick={() => update.mutate({ templateBody: template, parameters }, { onSuccess: () => preview.reset() })}
          >
            {update.isPending && <Loader2Icon className="animate-spin" />} Apply update
          </Button>
        </div>
        <ErrorLine error={preview.error ?? update.error} />
        {changes && changes.length === 0 && <p className="text-sm text-muted-foreground">No changes: the stack already matches this template and these parameters.</p>}
        {changes && changes.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Logical ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Replacement</TableHead>
                <TableHead>Changed properties</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.map((c, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Badge variant={ACTION[c.action]}>{c.action}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{c.logicalId}</TableCell>
                  <TableCell className="text-xs">{c.type}</TableCell>
                  <TableCell className="text-xs">{c.replacement === "True" ? <span className="font-medium text-destructive">True</span> : (c.replacement ?? "")}</TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal">{c.details ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
