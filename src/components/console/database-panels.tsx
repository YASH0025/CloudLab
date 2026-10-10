"use client";

import { format } from "date-fns";
import { CameraIcon, CheckIcon, CopyIcon, DatabaseZapIcon, HistoryIcon, Loader2Icon, PlugZapIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ResourceDTO } from "@/engine/types";
import { useDbConnect, useResources } from "@/hooks/use-cloud";
import { ApiError } from "@/lib/api-client";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { Step } from "./reachability-panel";
import { StateBadge } from "./state-badge";

function CopyText({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("flex min-w-0 items-center gap-1 rounded-md bg-muted px-2.5 py-1.5", className)}>
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={text}>
        {text}
      </code>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 shrink-0"
        aria-label="Copy"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          );
        }}
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** The connection command, filled in for this database (same as the server's connectCommand). */
function command(db: ResourceDTO) {
  const host = String(db.attributes.endpoint);
  const port = Number(db.attributes.port);
  const user = String(db.config.masterUsername);
  if (db.config.engine === "postgres") return `psql "host=${host} port=${port} user=${user} dbname=${db.config.dbName || "postgres"}"`;
  return `mysql -h ${host} -P ${port} -u ${user} -p${db.config.dbName ? ` ${db.config.dbName}` : ""}`;
}

// ---------- database ----------

export function DatabasePanel({ db }: { db: ResourceDTO }) {
  const a = db.attributes;
  const creating = db.state === "creating";
  const pending = (a.pendingModifiedValues as Record<string, unknown> | undefined) ?? {};

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DatabaseZapIcon className="size-4" /> Connectivity
          </CardTitle>
          <CardDescription>
            Apps connect to the endpoint name, never to an IP: when RDS fails over to the standby, the name stays the same and simply points at the new server.
          </CardDescription>
        </CardHeader>
        <CardContent className="py-2 pb-5">
          {creating ? (
            <p className="py-2 text-sm text-muted-foreground">The endpoint appears once the database has been created (about 15 seconds).</p>
          ) : (
            <dl className="divide-y">
              <Row label="Endpoint">
                <CopyText text={String(a.endpoint)} />
              </Row>
              <Row label="Port">{String(a.port)}</Row>
              <Row label="Connect with">
                <CopyText text={command(db)} />
              </Row>
              <Row label="Runs in">
                {String(a.availabilityZone)} <span className="font-mono text-xs text-muted-foreground">({String(a.privateIp)})</span>
              </Row>
              <Row label="Standby">
                {a.secondaryAvailabilityZone ? (
                  <>
                    {String(a.secondaryAvailabilityZone)}{" "}
                    <span className="text-xs text-muted-foreground">
                      kept in sync; takes over on failover{Number(a.failovers) > 0 ? ` (failed over ${String(a.failovers)}×)` : ""}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">None. Turn on Multi-AZ to keep one in another zone.</span>
                )}
              </Row>
              <Row label="Public address">
                {a.publicIp ? (
                  <span className="text-warning">{String(a.publicIp)}: reachable from outside the VPC if its security group allows it.</span>
                ) : (
                  <span className="text-muted-foreground">None (private). Only reachable from inside the VPC.</span>
                )}
              </Row>
              {Object.keys(pending).length > 0 && (
                <Row label="Waiting for maintenance">
                  <span className="font-mono text-xs">
                    {Object.entries(pending)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join(", ")}
                  </span>
                  <span className="block text-xs text-muted-foreground">Applies in the next maintenance window, or now with modify-db-instance --apply-immediately.</span>
                </Row>
              )}
            </dl>
          )}
        </CardContent>
      </Card>

      <ConnectionCheck db={db} />
      <DatabaseSnapshots db={db} />
    </>
  );
}

function ConnectionCheck({ db }: { db: ResourceDTO }) {
  const check = useDbConnect(db.id);
  const instances = useResources("compute", "instance");
  const [from, setFrom] = useState("internet");
  const [source, setSource] = useState("198.51.100.23/32");
  const vpcId = db.attributes.vpcId;
  const candidates = (instances.data ?? []).filter((i) => i.state !== "terminated");
  const inVpc = candidates.filter((i) => i.attributes.vpcId === vpcId);
  const elsewhere = candidates.filter((i) => i.attributes.vpcId !== vpcId);
  const result = check.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugZapIcon className="size-4" /> Can it connect?
        </CardTitle>
        <CardDescription>
          Check whether your app server, or someone on the internet, can open a connection to this database on port {String(db.attributes.port)}, link by link.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 py-2 pb-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 space-y-1.5">
            <Label htmlFor="db-from">From</Label>
            <Select value={from} onValueChange={setFrom}>
              <SelectTrigger id="db-from" aria-label="Connect from">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="internet">The internet (e.g. your laptop)</SelectItem>
                {inVpc.length > 0 && <SelectSeparator />}
                {inVpc.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.name ? `${i.name} (${i.id})` : i.id}
                  </SelectItem>
                ))}
                {elsewhere.length > 0 && <SelectSeparator />}
                {elsewhere.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.name ? `${i.name} (${i.id})` : i.id} · other VPC
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {from === "internet" && (
            <div className="w-52 space-y-1.5">
              <Label htmlFor="db-source">Your address</Label>
              <Input id="db-source" className="font-mono" value={source} onChange={(e) => setSource(e.target.value)} />
            </div>
          )}
          <Button onClick={() => check.mutate({ from, source })} disabled={check.isPending}>
            {check.isPending ? <Loader2Icon className="animate-spin" /> : <PlugZapIcon />} Check connection
          </Button>
        </div>

        {check.error && (
          <p className="text-sm text-destructive">
            {check.error instanceof ApiError ? `${check.error.code}: ` : ""}
            {check.error.message}
          </p>
        )}
        {result && (
          <div className="space-y-2">
            <p className={cn("text-sm font-medium", result.reachable ? "text-success" : "text-destructive")}>{result.summary}</p>
            <ol className="divide-y">
              {result.steps.map((s) => (
                <Step key={s.id} step={s} />
              ))}
            </ol>
            {result.reachable && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">From there, this connects (you’ll be asked for the master password):</p>
                <CopyText text={result.command} />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DatabaseSnapshots({ db }: { db: ResourceDTO }) {
  const snapshots = useResources("rds", "db-snapshot");
  const mine = (snapshots.data ?? []).filter((s) => s.config.dbInstanceIdentifier === db.name);
  const stamp = format(new Date(), "yyyyMMdd-HHmm");
  const canSnapshot = db.state === "available" || db.state === "stopped";

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <HistoryIcon className="size-4" /> Backups and snapshots
          </CardTitle>
          <CardDescription>
            {Number(db.config.backupRetentionPeriod) > 0
              ? `Automated backups are kept for ${String(db.config.backupRetentionPeriod)} days.`
              : "Automated backups are off (retention 0): if something goes wrong, only manual snapshots can save you."}{" "}
            Take a snapshot before risky changes, like a migration.
          </CardDescription>
        </div>
        <Button asChild={canSnapshot} size="sm" variant="outline" disabled={!canSnapshot}>
          {canSnapshot ? (
            <Link href={routes.createPrefilled("rds", "db-snapshot", { name: `${db.name}-${stamp}`, dbInstanceIdentifier: db.name })}>
              <CameraIcon /> Take snapshot
            </Link>
          ) : (
            <span>
              <CameraIcon /> Take snapshot
            </span>
          )}
        </Button>
      </CardHeader>
      <CardContent className="py-2 pb-5">
        {mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">No snapshots of this database yet.</p>
        ) : (
          <ul className="divide-y">
            {mine.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <Link href={routes.detail("rds", "db-snapshot", s.id)} className="text-primary hover:underline">
                  {s.name}
                </Link>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {format(new Date(s.createdAt), "PPp")} <StateBadge state={s.state} pending={s.pendingState} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- snapshot ----------

export function SnapshotPanel({ snapshot }: { snapshot: ResourceDTO }) {
  const a = snapshot.attributes;
  const ready = snapshot.state === "available";
  const prefill = {
    name: `${String(snapshot.config.dbInstanceIdentifier).slice(0, 50)}-restored`,
    snapshotIdentifier: snapshot.name,
    engine: a.engine,
    engineVersion: a.engineVersion,
    dbInstanceClass: a.dbInstanceClass,
    allocatedStorage: a.allocatedStorage,
    masterUsername: a.masterUsername,
    dbName: a.dbName ?? undefined,
    dbSubnetGroupName: a.dbSubnetGroupName,
  };
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Restore</CardTitle>
          <CardDescription>
            Restoring never overwrites a database: it creates a new one with this snapshot’s data and the same master user and password. Point your app at the
            new endpoint when it’s ready.
          </CardDescription>
        </div>
        {ready ? (
          <Button asChild size="sm">
            <Link href={routes.createPrefilled("rds", "db-instance", prefill)}>Restore to a new database</Link>
          </Button>
        ) : (
          <Badge variant="warning">Available to restore once it’s created</Badge>
        )}
      </CardHeader>
      <CardContent className="pb-5 text-sm text-muted-foreground">
        Pick the security groups on the next page. If you leave the default security group, your app servers probably can’t connect: a classic surprise after a
        restore.
      </CardContent>
    </Card>
  );
}
