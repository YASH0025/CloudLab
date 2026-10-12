"use client";

import {
  ArrowLeftRightIcon,
  BellRingIcon,
  BoxIcon,
  CloudIcon,
  DatabaseIcon,
  GlobeIcon,
  InboxIcon,
  LinkIcon,
  LockIcon,
  NetworkIcon,
  RouteIcon,
  ServerIcon,
  ShieldIcon,
  SplitIcon,
  TableIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Diagram, DiagramNode, DiagramRef, DiagramSubnet, DiagramVpc } from "@/guide/diagram";
import { useDiagram } from "@/hooks/use-cloud";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { useConsoleStore } from "@/stores/console-store";

const KIND: Record<DiagramSubnet["kind"], { label: string; Icon: LucideIcon; border: string; hint: string }> = {
  public: { label: "Public", Icon: GlobeIcon, border: "border-l-success", hint: "0.0.0.0/0 → internet gateway: reachable from the internet if a server has a public IP and its firewall allows it." },
  private: { label: "Private", Icon: ArrowLeftRightIcon, border: "border-l-primary", hint: "0.0.0.0/0 → NAT gateway: servers can reach out, nothing can reach in." },
  isolated: { label: "Isolated", Icon: LockIcon, border: "border-l-muted-foreground/40", hint: "No route out of the VPC (except peering or endpoints)." },
};

const ICONS: Record<string, LucideIcon> = { instance: ServerIcon, "db-instance": DatabaseIcon, "nat-gateway": ArrowLeftRightIcon, bucket: BoxIcon, function: CloudIcon, api: RouteIcon, topic: BellRingIcon, queue: InboxIcon, table: TableIcon };

const href = (r: DiagramRef) => routes.detail(r.service, r.type, r.id);
const display = (r: DiagramRef) => r.name || r.id;

/** Healthy-ish states read as fine; the rest are spelled out (never color alone). */
const GOOD = new Set(["running", "available", "active", "in-use"]);

function StateText({ state }: { state: string | null }) {
  if (!state) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px]", GOOD.has(state) ? "text-success" : "text-muted-foreground")}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {state}
    </span>
  );
}

function NodeRow({ n }: { n: DiagramNode }) {
  const Icon = ICONS[n.type] ?? BoxIcon;
  return (
    <li>
      <Link href={href(n)} className="group block rounded-md border bg-card px-2 py-1.5 transition-colors hover:border-primary/60">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium group-hover:text-primary">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{display(n)}</span>
          </span>
          <StateText state={n.state} />
        </div>
        {n.detail && <p className="truncate font-mono text-[11px] text-muted-foreground">{n.detail}</p>}
        {n.tags && (
          <div className="mt-1 flex flex-wrap gap-1">
            {n.tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-0.5 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                {n.type === "instance" && <ShieldIcon className="size-2.5" />}
                {t}
              </span>
            ))}
          </div>
        )}
      </Link>
    </li>
  );
}

function SubnetBox({ subnet }: { subnet: DiagramSubnet }) {
  const kind = KIND[subnet.kind];
  return (
    <div className={cn("space-y-2 rounded-md border border-l-4 bg-muted/30 p-2.5", kind.border)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={href(subnet)} className="block truncate text-sm font-medium hover:text-primary hover:underline">
            {display(subnet)}
          </Link>
          <p className="font-mono text-[11px] text-muted-foreground">{subnet.cidr}</p>
        </div>
        <Badge variant="secondary" title={kind.hint} className="shrink-0">
          <kind.Icon className="size-3" /> {kind.label}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {subnet.routeTable ? (
          <Link href={href(subnet.routeTable)} className="inline-flex min-w-0 items-center gap-1 font-mono break-all hover:text-primary">
            <RouteIcon className="size-3 shrink-0" /> {subnet.route}
          </Link>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1 font-mono break-all">
            <RouteIcon className="size-3 shrink-0" /> {subnet.route}
          </span>
        )}
        {subnet.acl && !subnet.acl.isDefault && (
          <Link href={href(subnet.acl)} className="inline-flex items-center gap-1 hover:text-primary">
            <ShieldIcon className="size-3" /> ACL {display(subnet.acl)}
          </Link>
        )}
      </div>
      {subnet.nodes.length > 0 ? (
        <ul className="space-y-1.5">
          {subnet.nodes.map((n) => (
            <NodeRow key={`${n.id}-${n.tags?.join() ?? ""}`} n={n} />
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">Empty</p>
      )}
    </div>
  );
}

function VpcCard({ vpc }: { vpc: DiagramVpc }) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 border-b py-4">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <NetworkIcon className="size-4 text-muted-foreground" />
            <Link href={href(vpc)} className="hover:text-primary hover:underline">
              {display(vpc)}
            </Link>
            <span className="font-mono text-xs font-normal text-muted-foreground">{vpc.cidr}</span>
            {vpc.isDefault && <Badge variant="secondary">Default VPC</Badge>}
          </CardTitle>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {vpc.internetGateway ? (
            <Link href={href(vpc.internetGateway)}>
              <Badge variant="success">
                <GlobeIcon className="size-3" /> Internet gateway {vpc.internetGateway.name || ""}
              </Badge>
            </Link>
          ) : (
            <Badge variant="secondary">
              <LockIcon className="size-3" /> No internet gateway
            </Badge>
          )}
          {vpc.endpoints.map((e) => (
            <Link key={e.id} href={href(e)}>
              <Badge variant="secondary" title={e.serviceName}>
                <BoxIcon className="size-3" /> Endpoint: {e.service === "s3" ? "S3" : "DynamoDB"}
              </Badge>
            </Link>
          ))}
          {vpc.peerings.map((p) => (
            <Link key={p.id} href={href(p)}>
              <Badge variant={p.state === "active" ? "default" : "secondary"} title={`${p.id} (${p.state ?? ""})`}>
                <LinkIcon className="size-3" /> Peered with {p.otherName}
                {p.state !== "active" && ` (${p.state})`}
              </Badge>
            </Link>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 py-4">
        {vpc.loadBalancers.map((lb) => (
          <Link key={lb.id} href={href(lb)} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 hover:border-primary/60">
            <span className="flex min-w-0 items-center gap-2 text-sm">
              <SplitIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-medium">{display(lb)}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">{lb.detail}</span>
            </span>
            <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
              spans {lb.zones.join(", ") || "no zones"} · {lb.targets.length} target{lb.targets.length === 1 ? "" : "s"} <StateText state={lb.state} />
            </span>
          </Link>
        ))}
        {vpc.zones.length === 0 ? (
          <p className="text-sm text-muted-foreground">No subnets yet. Servers, databases and load balancers live in subnets.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:[grid-template-columns:var(--zones)]" style={{ "--zones": `repeat(${vpc.zones.length}, minmax(0, 1fr))` } as React.CSSProperties}>
            {vpc.zones.map((z) => (
              <section key={z.name} className="min-w-0 space-y-2 rounded-lg border border-dashed p-2">
                <h3 className="px-1 text-xs font-medium text-muted-foreground">Availability Zone {z.name}</h3>
                {z.subnets.map((sub) => (
                  <SubnetBox key={sub.id} subnet={sub} />
                ))}
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {Object.entries(KIND).map(([k, v]) => (
        <li key={k} className="flex items-center gap-1.5" title={v.hint}>
          <span className={cn("h-3 w-1 rounded-full border-l-4", v.border)} aria-hidden />
          <v.Icon className="size-3" /> {v.label} subnet
        </li>
      ))}
    </ul>
  );
}

/** A live picture of the region's network. Everything links to its page. */
export function DiagramView() {
  const region = useConsoleStore((s) => s.region);
  const { data, isLoading, error } = useDiagram();
  const d: Diagram | undefined = data;
  const own = d?.vpcs.filter((v) => !v.isDefault) ?? [];
  const def = d?.vpcs.filter((v) => v.isDefault) ?? [];

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Network diagram</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Your network in <span className="font-mono">{region}</span>, the way architects draw it: each VPC, its Availability Zones, the subnets in them and what runs inside.
          Updates as you build. Click anything to open it.
        </p>
        <Legend />
      </div>
      {isLoading && <Skeleton className="h-96" />}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {d && (
        <>
          {[...own, ...def].map((v) => (
            <VpcCard key={v.id} vpc={v} />
          ))}
          <Card>
            <CardHeader>
              <CardTitle>Outside your VPCs</CardTitle>
              <CardDescription>Regional services you reach over AWS&apos;s network or the internet, not through a subnet: storage, functions, APIs, DynamoDB tables, topics and queues.</CardDescription>
            </CardHeader>
            <CardContent className="pb-5">
              {d.regional.length === 0 ? (
                <p className="text-sm text-muted-foreground">No S3 buckets, Lambda functions, APIs, DynamoDB tables, topics or queues in this region.</p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {d.regional.map((n) => (
                    <NodeRow key={n.id} n={n} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
