"use client";

import { format } from "date-fns";
import { ChevronLeftIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FieldDef, ResolvedTypeDef, ResourceDTO } from "@/engine/types";
import { useResource, useTypeDef, useUpdateResource } from "@/hooks/use-cloud";
import { ApiError } from "@/lib/api-client";
import { routes } from "@/lib/routes";
import { formatValue } from "@/lib/utils";
import { ConfirmDialog } from "./confirm-dialog";
import { AutoScalingPanel, LoadBalancerPanel, TargetHealthPanel } from "./load-balancing-panels";
import { ObjectsPanel, WebsiteCard } from "./objects-panel";
import { PermissionChecker } from "./permission-checker";
import { ReachabilityPanel } from "./reachability-panel";
import { ResourceForm } from "./resource-form";
import { StateBadge } from "./state-badge";
import { useResourceCommands } from "./use-resource-commands";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_1fr] gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function FieldValue({ field, value }: { field: FieldDef; value: unknown }) {
  if (field.type === "ref" && field.ref?.by === "name") {
    return <span className="font-mono text-xs">{value ? String(value) : "–"}</span>;
  }
  if (field.type === "ref" && field.ref) {
    const ids = Array.isArray(value) ? (value as string[]) : value ? [String(value)] : [];
    if (ids.length === 0) return <>–</>;
    return (
      <span className="flex flex-wrap gap-x-3">
        {ids.map((id) => (
          <Link
            key={id}
            href={routes.detail(field.ref!.service, field.ref!.type, id)}
            className="font-mono text-xs text-primary hover:underline"
          >
            {id}
          </Link>
        ))}
      </span>
    );
  }
  if (field.type === "json") {
    let pretty = String(value ?? "");
    try {
      pretty = JSON.stringify(JSON.parse(pretty), null, 2);
    } catch {
      // Shown as stored.
    }
    return <pre className="max-h-80 overflow-auto rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed">{pretty}</pre>;
  }
  if (field.type === "policies") {
    const arns = Array.isArray(value) ? (value as string[]) : [];
    if (arns.length === 0) return <span className="text-muted-foreground">None</span>;
    return (
      <ul className="space-y-0.5">
        {arns.map((a) => (
          <li key={a}>
            {a.split("/").pop()} <span className="font-mono text-xs text-muted-foreground">{a}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (field.type === "enum") {
    const opt = field.options?.find((o) => o.value === value);
    return <>{opt ? opt.label : formatValue(value)}</>;
  }
  if (field.type === "list" && Array.isArray(value)) {
    const items = field.item ?? [];
    if (value.length === 0) return <span className="text-muted-foreground">None</span>;
    return (
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {items.map((i) => (
                <TableHead key={i.key}>{i.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {value.map((row: Record<string, unknown>, idx) => (
              <TableRow key={idx}>
                {items.map((i) => (
                  <TableCell key={i.key} className={i.type === "cidr" ? "font-mono text-xs" : undefined}>
                    {i.type === "enum" ? (i.options?.find((o) => o.value === row[i.key])?.label ?? "–") : formatValue(row[i.key])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }
  return <span className={field.type === "cidr" ? "font-mono" : undefined}>{formatValue(value)}</span>;
}

function hasEditableFields(def: ResolvedTypeDef) {
  return def.fields.some((f) => !f.immutable);
}

function camelToLabel(key: string) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

export function ResourceDetailView() {
  const params = useParams<{ service: string; type: string; id: string }>();
  const id = decodeURIComponent(params.id);
  const router = useRouter();
  const { typeDef } = useTypeDef(params.service, params.type);
  const query = useResource(id);
  const update = useUpdateResource(id);
  const commands = useResourceCommands(typeDef, () => router.push(routes.list(params.service, params.type)));

  if (query.isLoading || !typeDef) return <Skeleton className="h-96" />;
  if (query.error) {
    const err = query.error;
    return (
      <div className="space-y-2">
        <p className="font-mono text-sm text-destructive">{err instanceof ApiError ? err.code : "Error"}</p>
        <p className="text-muted-foreground">{err.message}</p>
        <Button variant="outline" asChild>
          <Link href={routes.list(params.service, params.type)}>Back to {typeDef.pluralLabel}</Link>
        </Button>
      </div>
    );
  }

  const { item, referencedBy } = query.data!;
  const actions = Object.entries(typeDef.lifecycle?.actions ?? {});
  // The platform's own markers are shown as badges, not as rows.
  // Some attributes have a panel of their own (scaling activities, health check bookkeeping).
  const inPanels = new Set(typeDef.panelAttributes ?? []);
  const attributes = Object.entries(item.attributes).filter(([k, v]) => v !== undefined && k !== "system" && !inPanels.has(k));
  const system = (item.attributes.system ?? {}) as { isDefault?: boolean; main?: boolean; defaultForAz?: boolean };
  const systemBadge = system.main
    ? "Main route table"
    : system.defaultForAz
      ? "Default subnet"
      : system.isDefault
        ? item.type === "vpc"
          ? "Default VPC"
          : "Default security group"
        : null;

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={routes.list(params.service, params.type)}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon className="size-4" /> {typeDef.pluralLabel}
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{item.name || item.id}</h1>
            <StateBadge state={item.state} pending={item.pendingState} />
            {systemBadge && (
              <Badge variant="secondary" title="Created by the platform, as in a real AWS account">
                {systemBadge}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {actions.map(([key, a]) => (
              <Button
                key={key}
                variant={a.destructive ? "destructive" : "outline"}
                size="sm"
                disabled={commands.pending || !item.state || !a.from.includes(item.state)}
                onClick={() => commands.runAction(item, key)}
              >
                {a.label}
              </Button>
            ))}
            <Button variant="outline" size="sm" onClick={() => commands.remove(item)} disabled={commands.pending}>
              <Trash2Icon /> Delete
            </Button>
          </div>
        </div>
        <p className="font-mono text-xs text-muted-foreground">{item.id}</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="py-2">
            <dl className="divide-y">
              <Row label="ID">
                <span className="font-mono text-xs break-all">{item.id}</span>
              </Row>
              <Row label="Region">{item.region}</Row>
              {item.state && (
                <Row label="State">
                  {item.state}
                  {item.pendingState && <span className="text-muted-foreground"> → {item.pendingState}</span>}
                </Row>
              )}
              <Row label="Created">{format(new Date(item.createdAt), "PPpp")}</Row>
              {attributes.map(([k, v]) => (
                <Row key={k} label={camelToLabel(k)}>
                  <span className="font-mono text-xs">{formatValue(v)}</span>
                </Row>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Used by</CardTitle>
            <CardDescription>Resources that reference this one. They must be removed before it can be deleted.</CardDescription>
          </CardHeader>
          <CardContent className="py-2">
            {referencedBy.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">Nothing depends on this resource.</p>
            ) : (
              <ul className="divide-y">
                {referencedBy.map((r: ResourceDTO) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <Link href={routes.detail(r.service, r.type, r.id)} className="text-primary hover:underline">
                      {r.name || r.id}
                      <span className="block font-mono text-xs text-muted-foreground">{r.id}</span>
                    </Link>
                    <StateBadge state={r.state} pending={r.pendingState} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent className="py-2">
          <dl className="divide-y">
            {typeDef.fields.map((f) => (
              <Row key={f.key} label={f.label}>
                <FieldValue field={f} value={item.config[f.key]} />
              </Row>
            ))}
          </dl>
        </CardContent>
      </Card>

      {item.service === "compute" && item.type === "instance" && <ReachabilityPanel instanceId={item.id} />}
      {item.type === "load-balancer" && <LoadBalancerPanel lb={item} />}
      {item.type === "target-group" && <TargetHealthPanel targetGroup={item} />}
      {item.type === "auto-scaling-group" && <AutoScalingPanel group={item} />}
      {item.service === "iam" && (item.type === "user" || item.type === "group" || item.type === "role") && (
        <PermissionChecker kind={item.type} name={item.name} />
      )}
      {item.service === "storage" && item.type === "bucket" && (
        <>
          <ObjectsPanel bucket={item.id} />
          <WebsiteCard bucket={item} />
        </>
      )}

      {hasEditableFields(typeDef) && (
        <Card>
          <CardHeader>
            <CardTitle>Edit settings</CardTitle>
            <CardDescription>Some settings are fixed at creation or can only change in certain states.</CardDescription>
          </CardHeader>
          <CardContent className="py-6">
            <ResourceForm
              // Live pages refresh often; only reset the form when the settings themselves change.
              key={JSON.stringify(item.config)}
              fields={typeDef.fields}
              mode="edit"
              currentState={item.state}
              initialValues={item.config}
              submitLabel="Save changes"
              pending={update.isPending}
              error={update.error}
              onSubmit={(values) => update.mutate(values)}
            />
          </CardContent>
        </Card>
      )}

      <ConfirmDialog request={commands.confirm} onClose={commands.closeConfirm} pending={commands.pending} />
    </div>
  );
}
