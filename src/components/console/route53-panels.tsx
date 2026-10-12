"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { CheckCircle2Icon, GlobeIcon, PlusIcon, SearchIcon, Trash2Icon, XCircleIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceDTO } from "@/engine/types";
import type { ZoneRequest } from "@/engine/route53/dns";
import { useDeleteResource, useDnsTest, useHealthCheckStatus, useResources } from "@/hooks/use-cloud";
import { ApiError, type DnsTestResult } from "@/lib/api-client";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

const TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SOA"];

const isSystem = (r: ResourceDTO) => !!(r.attributes.system as { ownedBy?: string } | undefined)?.ownedBy;
const errorText = (e: unknown) => (e instanceof ApiError ? `${e.code}: ${e.message}` : e ? String(e) : "");

/** The part of a full name before the zone ("www"), or "" for the apex. */
const relative = (fqdn: string, zone: string) => (fqdn === zone ? "" : fqdn.slice(0, -(zone.length + 1)));

function routingText(r: ResourceDTO) {
  const c = r.config as { routingPolicy?: string; setIdentifier?: string; weight?: number; failover?: string };
  if (c.routingPolicy === "weighted") return `Weighted · ${c.setIdentifier} · ${c.weight}`;
  if (c.routingPolicy === "failover") return `Failover · ${c.setIdentifier} · ${c.failover === "PRIMARY" ? "Primary" : "Secondary"}`;
  return "Simple";
}

// ---------- hosted zone ----------

export function HostedZonePanel({ zone }: { zone: ResourceDTO }) {
  const all = useResources("route53", "record-set");
  const remove = useDeleteResource();
  const records = (all.data ?? [])
    .filter((r) => r.config.zoneId === zone.id)
    .sort((a, b) => a.name.split(".").reverse().join(".").localeCompare(b.name.split(".").reverse().join(".")) || String(a.config.type).localeCompare(String(b.config.type)));
  const nameServers = (zone.attributes.nameServers as string[] | undefined) ?? [];
  const recent = (zone.attributes.recentRequests as ZoneRequest[] | undefined) ?? [];

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>Records ({records.length})</CardTitle>
            <CardDescription>
              Each record answers one question, like “what’s the address of www.{zone.name}?”. NS and SOA came with the zone: they say which servers answer for {zone.name}.
            </CardDescription>
          </div>
          <Button asChild size="sm">
            <Link href={routes.createPrefilled("route53", "record-set", { zoneId: zone.id })}>
              <PlusIcon /> Create record
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="py-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Record name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="hidden md:table-cell">Routing</TableHead>
                <TableHead>Value / route traffic to</TableHead>
                <TableHead className="hidden sm:table-cell">TTL</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">
                    <Link href={routes.detail("route53", "record-set", r.id)} className="text-primary hover:underline">
                      {r.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{String(r.config.type)}</Badge>
                    {r.config.alias === true && <span className="ml-1 text-xs text-muted-foreground">alias</span>}
                  </TableCell>
                  <TableCell className="hidden text-xs md:table-cell">{routingText(r)}</TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal">
                    <div className="max-w-[26rem] break-all">
                      {r.config.alias ? (
                        <span>{String(r.config.aliasTarget)}</span>
                      ) : (
                        ((r.config.values as { value: string }[] | undefined) ?? []).map((v, i) => <div key={i}>{v.value}</div>)
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-xs tabular-nums sm:table-cell">{r.config.alias ? "–" : String(r.config.ttl)}</TableCell>
                  <TableCell>
                    {!isSystem(r) && (
                      <button
                        type="button"
                        aria-label={`Delete ${r.name} ${String(r.config.type)}`}
                        className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(r.id)}
                      >
                        <Trash2Icon className="size-4" />
                      </button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <DnsTestCard defaultName={`www.${zone.name}`} />
        <div className="space-y-5">
          <AliasTargetsCard zone={zone} />
          <Card>
            <CardHeader>
              <CardTitle>Name servers</CardTitle>
              <CardDescription>
                On AWS, you’d copy these to the company where you registered {zone.name}, so the internet knows to ask Route 53. In CloudLab the zone works straight away.
              </CardDescription>
            </CardHeader>
            <CardContent className="pb-5">
              <ul className="space-y-0.5 font-mono text-xs">
                {nameServers.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
          {recent.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Recent requests</CardTitle>
                <CardDescription>Web requests to names in this zone, from the terminal’s curl or the test above.</CardDescription>
              </CardHeader>
              <CardContent className="pb-5">
                <ul className="divide-y text-sm">
                  {recent.slice(0, 8).map((q, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="truncate font-mono text-xs">{q.host}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {q.failover && <span title="Which failover record answered">{q.failover === "PRIMARY" ? "primary" : "secondary"}</span>}
                        <Badge variant={q.status && q.status < 400 ? "success" : "destructive"}>{q.status ?? "no answer"}</Badge>
                        {formatDistanceToNowStrict(new Date(q.at), { addSuffix: true })}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

/** AWS resources an alias record can point at, one click away from a pre-filled record. */
function AliasTargetsCard({ zone }: { zone: ResourceDTO }) {
  const lbs = useResources("loadbalancing", "load-balancer");
  const apis = useResources("apigateway", "api");
  const buckets = useResources("storage", "bucket");
  const targets = [
    ...(lbs.data ?? []).map((l) => ({ label: `Load balancer ${l.name}`, target: String(l.attributes.dnsName), name: "www" })),
    ...(apis.data ?? []).map((a) => ({ label: `API ${a.name}`, target: String(a.attributes.apiEndpoint).replace(/^https:\/\//, ""), name: "api" })),
    ...(buckets.data ?? [])
      .filter((b) => b.config.websiteEnabled && (b.id === zone.name || b.id.endsWith(`.${zone.name}`)))
      .map((b) => ({ label: `S3 website ${b.id}`, target: `s3-website.${b.region}.cloudlab.local`, name: relative(b.id, zone.name) })),
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Point a name at your resources</CardTitle>
        <CardDescription>
          Alias records follow the resource even when its IP addresses change. An S3 website only works under a name equal to its bucket&apos;s name (bucket www.{zone.name} → www.{zone.name}).
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-5">
        {targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No load balancers, APIs or matching S3 websites in this region yet. You can still create A records with a server&apos;s public IP.</p>
        ) : (
          <ul className="divide-y text-sm">
            {targets.map((t) => (
              <li key={t.target + t.label} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p>{t.label}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{t.target}</p>
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link href={routes.createPrefilled("route53", "record-set", { zoneId: zone.id, name: t.name, type: "A", alias: true, aliasTarget: t.target })}>Create alias</Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- testing a name ----------

export function DnsTestCard({ defaultName, title = "Test a name" }: { defaultName: string; title?: string }) {
  const [name, setName] = useState(defaultName);
  const [type, setType] = useState("A");
  const test = useDnsTest();
  const result = test.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SearchIcon className="size-4" /> {title}
        </CardTitle>
        <CardDescription>What DNS answers for a name, step by step, and what a browser gets when it opens it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pb-5">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) test.mutate({ name: name.trim(), type, http: type === "A" });
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 font-mono text-xs" aria-label="Name to test" />
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-24" aria-label="Record type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" disabled={test.isPending}>
            Test
          </Button>
        </form>
        {test.error && <p className="text-sm text-destructive">{errorText(test.error)}</p>}
        {result && <DnsResult result={result} />}
        <p className="text-xs text-muted-foreground">
          In the terminal:{" "}
          <Link className="font-mono text-primary hover:underline" href={routes.terminalWith(`dig ${name.trim()}${type === "A" ? "" : ` ${type}`}`)}>
            dig {name.trim()}
            {type === "A" ? "" : ` ${type}`}
          </Link>
          {type === "A" && (
            <>
              {" · "}
              <Link className="font-mono text-primary hover:underline" href={routes.terminalWith(`curl -i http://${name.trim()}`)}>
                curl -i http://{name.trim()}
              </Link>
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

function DnsResult({ result }: { result: DnsTestResult }) {
  const { dns, http } = result;
  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-md border">
        <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5">
          <span className="font-mono text-xs">
            {dns.question.name} {dns.question.type}
          </span>
          <Badge variant={dns.status === "NOERROR" && dns.answers.length ? "success" : dns.status === "NOERROR" ? "secondary" : "destructive"}>
            {dns.status === "NOERROR" && !dns.answers.length ? "NOERROR (no answer)" : dns.status}
          </Badge>
        </div>
        {dns.answers.length > 0 && (
          <ul className="px-3 py-2 font-mono text-xs">
            {dns.answers.map((a, i) => (
              <li key={i} className="break-all">
                {a.name} <span className="text-muted-foreground">{a.ttl}</span> {a.type} <span className="font-medium">{a.value}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
        {dns.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {http && (
        <div className={cn("rounded-md border p-3", http.ok && http.status < 400 ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5")}>
          <p className="flex items-center gap-2 font-medium">
            <GlobeIcon className="size-4" />
            {http.ok ? `HTTP ${http.status} ${http.statusText}` : http.error}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{http.ok ? `Answered by ${http.servedBy}.` : http.reason}</p>
          {http.ok && http.body && <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{http.body}</pre>}
        </div>
      )}
    </div>
  );
}

// ---------- health check ----------

export function HealthCheckPanel({ check }: { check: ResourceDTO }) {
  const status = useHealthCheckStatus(check.id);
  const records = useResources("route53", "record-set");
  const users = (records.data ?? []).filter((r) => r.config.healthCheckId === check.id);
  const s = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {s ? (
            s.healthy ? (
              <Badge variant="success">
                <CheckCircle2Icon className="size-3" /> Healthy
              </Badge>
            ) : (
              <Badge variant="destructive">
                <XCircleIcon className="size-3" /> Unhealthy
              </Badge>
            )
          ) : (
            <Badge variant="secondary">Checking…</Badge>
          )}
          <span className="font-mono text-sm">{String(check.attributes.endpoint)}</span>
        </CardTitle>
        <CardDescription>Checkers in several regions call the endpoint; CloudLab checks again every 10 seconds while this page is open.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pb-5 text-sm">
        {status.error && <p className="text-destructive">{errorText(status.error)}</p>}
        {s && (
          <p className="font-mono text-xs">
            {s.report} <span className="text-muted-foreground">({formatDistanceToNowStrict(new Date(s.checkedAt), { addSuffix: true })})</span>
          </p>
        )}
        <div>
          <p className="text-xs font-medium text-muted-foreground">Used by</p>
          {users.length === 0 ? (
            <p className="text-muted-foreground">
              No records yet. Pick this health check on a weighted or failover record, so Route 53 stops sending people to the endpoint while it&apos;s down.
            </p>
          ) : (
            <ul>
              {users.map((r) => (
                <li key={r.id}>
                  <Link href={routes.detail("route53", "record-set", r.id)} className="font-mono text-xs text-primary hover:underline">
                    {r.name} {String(r.config.type)} ({routingText(r)})
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
