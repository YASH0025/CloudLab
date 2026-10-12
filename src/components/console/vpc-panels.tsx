"use client";

import { ArrowRightIcon, CheckCircle2Icon, ShieldIcon, XCircleIcon } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceDTO } from "@/engine/types";
import { useResources } from "@/hooks/use-cloud";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

interface AclRule {
  ruleNumber: number;
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidr: string;
  action: "allow" | "deny";
}

const isDefault = (r: ResourceDTO) => !!(r.attributes.system as { isDefault?: boolean } | undefined)?.isDefault;

function RulesTable({ rules, title, hint }: { rules: AclRule[]; title: string; hint: string }) {
  const sorted = [...rules].sort((a, b) => a.ruleNumber - b.ruleNumber);
  return (
    <div className="min-w-0 space-y-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Rule #</TableHead>
            <TableHead>Protocol</TableHead>
            <TableHead>Ports</TableHead>
            <TableHead>Address range</TableHead>
            <TableHead>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...sorted, { ruleNumber: -1, protocol: "all", cidr: "0.0.0.0/0", action: "deny" as const }].map((r) => (
            <TableRow key={r.ruleNumber} className={cn(r.ruleNumber === -1 && "text-muted-foreground")}>
              <TableCell className="font-mono text-xs">{r.ruleNumber === -1 ? "*" : r.ruleNumber}</TableCell>
              <TableCell className="text-xs">{r.protocol === "all" ? "All" : r.protocol.toUpperCase()}</TableCell>
              <TableCell className="font-mono text-xs">{r.protocol === "tcp" || r.protocol === "udp" ? (r.fromPort === r.toPort ? r.fromPort : `${r.fromPort}–${r.toPort}`) : "All"}</TableCell>
              <TableCell className="font-mono text-xs">{r.cidr}</TableCell>
              <TableCell>
                <Badge variant={r.action === "allow" ? "success" : "destructive"}>{r.action === "allow" ? "Allow" : "Deny"}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function NetworkAclPanel({ acl }: { acl: ResourceDTO }) {
  const subnets = useResources("networking", "subnet");
  const acls = useResources("networking", "network-acl");
  const inVpc = (subnets.data ?? []).filter((s) => s.config.vpcId === acl.config.vpcId);
  const customOf = (s: ResourceDTO) => (acls.data ?? []).find((a) => ((a.config.subnetIds as string[] | undefined) ?? []).includes(s.id));
  const using = inVpc.filter((s) => (isDefault(acl) ? !customOf(s) : customOf(s)?.id === acl.id));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldIcon className="size-4" /> Rules, in the order they’re checked
        </CardTitle>
        <CardDescription>
          For each packet, rules are checked from the lowest number; the first match decides and the rest are ignored. If nothing matches, the last rule (*) denies. Stateless: replies are checked too.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pb-5">
        <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          <RulesTable rules={(acl.config.inboundRules as AclRule[] | undefined) ?? []} title="Inbound" hint="Traffic coming into the subnet, including replies to connections it started." />
          <RulesTable rules={(acl.config.outboundRules as AclRule[] | undefined) ?? []} title="Outbound" hint="Traffic leaving the subnet, including replies to visitors (ports 1024–65535)." />
        </div>
        <div>
          <h3 className="text-sm font-medium">Subnets using this ACL</h3>
          {using.length === 0 ? (
            <p className="text-sm text-muted-foreground">None. Add subnets under Associated subnets below; each subnet uses exactly one network ACL.</p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-2">
              {using.map((s) => (
                <li key={s.id}>
                  <Link href={routes.detail("networking", "subnet", s.id)} className="font-mono text-xs text-primary hover:underline">
                    {s.name || s.id}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {isDefault(acl) && <p className="mt-1 text-xs text-muted-foreground">This is the VPC’s default ACL: every subnet that isn’t associated with another ACL uses it.</p>}
        </div>
      </CardContent>
    </Card>
  );
}

interface Route {
  destination: string;
  vpcPeeringConnectionId?: string;
}

/** For each side of a peering connection: which route tables send the other VPC's range through it. */
export function PeeringPanel({ peering }: { peering: ResourceDTO }) {
  const tables = useResources("networking", "route-table");
  const vpcs = useResources("networking", "vpc");
  const vpc = (id: unknown) => (vpcs.data ?? []).find((v) => v.id === id);
  const sides = [
    { from: vpc(peering.config.vpcId), to: vpc(peering.config.peerVpcId), role: "Requester" },
    { from: vpc(peering.config.peerVpcId), to: vpc(peering.config.vpcId), role: "Accepter" },
  ];
  const active = peering.state === "active";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Routes through this connection</CardTitle>
        <CardDescription>
          {peering.state === "pending-acceptance"
            ? "Waiting for the accepter VPC's owner to accept (Accept request, at the top). Nothing flows until then."
            : "Traffic only flows where a route table sends the other VPC's range to this connection, on both sides, so replies can come back."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 pb-5 md:grid-cols-2">
        {sides.map(({ from, to, role }) => {
          const theirs = (tables.data ?? []).filter((t) => t.config.vpcId === from?.id);
          return (
            <div key={role} className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">
                {role}: <span className="font-mono text-xs">{from?.name || from?.id}</span> <span className="text-muted-foreground">({String(from?.config.cidrBlock ?? "")})</span>
              </p>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                needs <span className="font-mono">{String(to?.config.cidrBlock ?? "")}</span> <ArrowRightIcon className="size-3" /> <span className="font-mono">{peering.id}</span>
              </p>
              <ul className="space-y-1">
                {theirs.map((t) => {
                  const ok = ((t.config.routes as Route[] | undefined) ?? []).some((r) => r.vpcPeeringConnectionId === peering.id);
                  return (
                    <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {ok ? <CheckCircle2Icon className="size-4 shrink-0 text-success" /> : <XCircleIcon className="size-4 shrink-0 text-muted-foreground" />}
                        <Link href={routes.detail("networking", "route-table", t.id)} className="truncate font-mono text-xs text-primary hover:underline">
                          {t.name || t.id}
                        </Link>
                      </span>
                      {!ok && active && to && (
                        <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
                          <Link href={routes.detail("networking", "route-table", t.id)}>Add route</Link>
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
