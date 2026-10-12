"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { AlertTriangleIcon, BellPlusIcon, CheckCircle2Icon, CircleHelpIcon, LayoutDashboardIcon, ScrollTextIcon, SirenIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseDashboardBody, type DashboardWidget } from "@/engine/cloudwatch-dashboard";
import type { ResourceDTO } from "@/engine/types";
import { useLogEvents, useLogStreams, useMetricSeries, useResources } from "@/hooks/use-cloud";
import { api, ApiError, type MetricQuery } from "@/lib/api-client";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { useConsoleStore } from "@/stores/console-store";
import { formatValue, MetricChart } from "./metric-chart";

// ---------- shared ----------

const RANGES = [
  { minutes: 60, label: "1h" },
  { minutes: 180, label: "3h" },
  { minutes: 720, label: "12h" },
  { minutes: 1440, label: "1d" },
  { minutes: 10080, label: "1w" },
];

/** The same period the server picks when none is given (keeps graphs under ~360 points). */
const autoPeriod = (minutes: number) => Math.max(60, Math.ceil((minutes * 60) / 360 / 60) * 60);

function RangePicker({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  return (
    <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Time range">
      {RANGES.map((r) => (
        <button
          key={r.minutes}
          type="button"
          aria-pressed={value === r.minutes}
          onClick={() => onChange(r.minutes)}
          className={cn(
            "rounded px-2 py-0.5 text-xs tabular-nums transition-colors",
            value === r.minutes ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

const SimulatedBadge = () => (
  <Badge variant="secondary" title="Nothing really runs on this resource in CloudLab, so this metric is generated to behave like the real one.">
    Simulated
  </Badge>
);

export interface ChartSpec {
  id: string;
  title: string;
  query: MetricQuery;
  /** Values to pre-fill in the "Create alarm" form. */
  alarm?: { name: string; threshold: number; comparisonOperator?: string; treatMissingData?: string };
}

const metricQuery = (id: string, namespace: string, name: string, dims: Record<string, string>, stat: MetricQuery["stat"]): MetricQuery => ({
  id,
  namespace,
  name,
  stat,
  dimensions: Object.entries(dims).map(([Name, Value]) => ({ Name, Value })),
});

/** Which graphs each kind of resource shows, as on its page in the AWS console. */
export function monitoringFor(item: ResourceDTO): { charts: ChartSpec[]; note?: string } | null {
  const n = item.name;
  if (item.service === "lambda" && item.type === "function") {
    const d = { FunctionName: n };
    return {
      note: "Real numbers: every invocation (test, CLI or API Gateway) is counted.",
      charts: [
        { id: "inv", title: "Invocations", query: metricQuery("inv", "AWS/Lambda", "Invocations", d, "Sum") },
        {
          id: "err",
          title: "Errors",
          query: metricQuery("err", "AWS/Lambda", "Errors", d, "Sum"),
          alarm: { name: `${n}-errors`, threshold: 0, treatMissingData: "notBreaching" },
        },
        { id: "dur", title: "Duration", query: metricQuery("dur", "AWS/Lambda", "Duration", d, "Average"), alarm: { name: `${n}-slow`, threshold: 1000 } },
        { id: "thr", title: "Throttles", query: metricQuery("thr", "AWS/Lambda", "Throttles", d, "Sum"), alarm: { name: `${n}-throttles`, threshold: 0, treatMissingData: "notBreaching" } },
      ],
    };
  }
  if (item.service === "apigateway" && item.type === "api") {
    const d = { ApiId: item.id };
    return {
      note: "Real numbers: every request to the API's URL is counted.",
      charts: [
        { id: "count", title: "Count (requests)", query: metricQuery("count", "AWS/ApiGateway", "Count", d, "Sum") },
        { id: "4xx", title: "4xx errors", query: metricQuery("4xx", "AWS/ApiGateway", "4xx", d, "Sum"), alarm: { name: `${n}-4xx`, threshold: 5, treatMissingData: "notBreaching" } },
        { id: "5xx", title: "5xx errors", query: metricQuery("5xx", "AWS/ApiGateway", "5xx", d, "Sum"), alarm: { name: `${n}-5xx`, threshold: 0, treatMissingData: "notBreaching" } },
        { id: "lat", title: "Latency", query: metricQuery("lat", "AWS/ApiGateway", "Latency", d, "Average"), alarm: { name: `${n}-latency`, threshold: 1000 } },
      ],
    };
  }
  if (item.service === "compute" && item.type === "instance") {
    return {
      charts: [
        {
          id: "cpu",
          title: "CPU utilization",
          query: metricQuery("cpu", "AWS/EC2", "CPUUtilization", { InstanceId: item.id }, "Average"),
          alarm: { name: `${n || item.id}-high-cpu`, threshold: 80 },
        },
      ],
    };
  }
  if (item.type === "load-balancer") {
    const d = { LoadBalancer: item.id.split(":loadbalancer/")[1] ?? n };
    return {
      note: "Real numbers from requests sent through the load balancer (for example with 'Send test traffic').",
      charts: [
        { id: "req", title: "Request count", query: metricQuery("req", "AWS/ApplicationELB", "RequestCount", d, "Sum") },
        {
          id: "5xx",
          title: "HTTP 5XX from the load balancer",
          query: metricQuery("5xx", "AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", d, "Sum"),
          alarm: { name: `${n}-5xx`, threshold: 0, treatMissingData: "notBreaching" },
        },
        { id: "rt", title: "Target response time", query: metricQuery("rt", "AWS/ApplicationELB", "TargetResponseTime", d, "Average"), alarm: { name: `${n}-slow`, threshold: 1 } },
      ],
    };
  }
  if (item.type === "auto-scaling-group") {
    const d = { AutoScalingGroupName: n };
    return {
      charts: [
        { id: "cpu", title: "CPU utilization (group average)", query: metricQuery("cpu", "AWS/EC2", "CPUUtilization", d, "Average"), alarm: { name: `${n}-high-cpu`, threshold: 70 } },
        { id: "inservice", title: "In-service instances", query: metricQuery("inservice", "AWS/AutoScaling", "GroupInServiceInstances", d, "Average") },
      ],
    };
  }
  if (item.type === "db-instance") {
    const d = { DBInstanceIdentifier: n };
    return {
      charts: [
        { id: "cpu", title: "CPU utilization", query: metricQuery("cpu", "AWS/RDS", "CPUUtilization", d, "Average"), alarm: { name: `${n}-high-cpu`, threshold: 80 } },
        { id: "conn", title: "Database connections", query: metricQuery("conn", "AWS/RDS", "DatabaseConnections", d, "Average") },
        {
          id: "free",
          title: "Free storage space",
          query: metricQuery("free", "AWS/RDS", "FreeStorageSpace", d, "Minimum"),
          alarm: { name: `${n}-low-storage`, threshold: 2 * 1024 ** 3, comparisonOperator: "LessThanThreshold" },
        },
      ],
    };
  }
  return null;
}

function alarmLink(spec: ChartSpec) {
  const q = spec.query;
  return routes.createPrefilled("cloudwatch", "alarm", {
    name: spec.alarm?.name,
    namespace: q.namespace,
    metricName: q.name,
    dimensions: q.dimensions.map((d) => ({ name: d.Name, value: d.Value })),
    statistic: q.stat,
    period: 60,
    evaluationPeriods: 1,
    comparisonOperator: spec.alarm?.comparisonOperator ?? "GreaterThanThreshold",
    threshold: spec.alarm?.threshold,
    treatMissingData: spec.alarm?.treatMissingData ?? "missing",
  });
}

/** The "Monitoring" tab of a resource page: a few graphs with a shared time range. */
export function MonitoringCard({ item }: { item: ResourceDTO }) {
  const spec = monitoringFor(item);
  const [minutes, setMinutes] = useState(60);
  const queries = useMemo(() => spec?.charts.map((c) => c.query) ?? [], [spec]);
  const metrics = useMetricSeries(queries, minutes);
  const [adding, setAdding] = useState<ChartSpec | null>(null);
  if (!spec) return null;
  const data = metrics.data;
  const simulated = data?.series.some((s) => s.simulated);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">Monitoring {simulated && <SimulatedBadge />}</CardTitle>
          <CardDescription>
            CloudWatch metrics, one point per {autoPeriod(minutes) / 60} minute{autoPeriod(minutes) > 60 ? "s" : ""}. Updates every 15 seconds.
            {spec.note && !simulated ? ` ${spec.note}` : ""}
          </CardDescription>
        </div>
        <RangePicker value={minutes} onChange={setMinutes} />
      </CardHeader>
      <CardContent className="grid gap-x-6 gap-y-5 pb-5 md:grid-cols-2">
        {spec.charts.map((c) => {
          const series = data?.series.find((s) => s.id === c.id);
          return (
            <figure key={c.id} className="min-w-0">
              <figcaption className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{c.title}</span>
                <span className="text-xs text-muted-foreground">
                  {c.query.stat} · {c.query.name}
                </span>
              </figcaption>
              <MetricChart series={series} from={data?.from ?? 0} to={data?.to ?? 1} loading={metrics.isLoading} label={`${c.query.stat} of ${c.query.name}`} />
              <div className="mt-1 flex gap-3 text-xs">
                <Link href={alarmLink(c)} className="inline-flex items-center gap-1 text-primary hover:underline">
                  <BellPlusIcon className="size-3.5" /> Create alarm
                </Link>
                <button type="button" onClick={() => setAdding(c)} className="inline-flex items-center gap-1 text-primary hover:underline">
                  <LayoutDashboardIcon className="size-3.5" /> Add to dashboard
                </button>
              </div>
            </figure>
          );
        })}
      </CardContent>
      <AddToDashboardDialog spec={adding} onClose={() => setAdding(null)} />
    </Card>
  );
}

// ---------- add to dashboard ----------

const NEW = "__new__";

function widgetFor(spec: ChartSpec, region: string) {
  const q = spec.query;
  return {
    type: "metric",
    width: 12,
    height: 6,
    properties: {
      title: spec.title,
      region,
      stat: q.stat,
      period: 60,
      metrics: [[q.namespace, q.name, ...q.dimensions.flatMap((d) => [d.Name, d.Value])]],
    },
  };
}

function AddToDashboardDialog({ spec, onClose }: { spec: ChartSpec | null; onClose: () => void }) {
  const dashboards = useResources("cloudwatch", "dashboard");
  const qc = useQueryClient();
  const [choice, setChoice] = useState<string | null>(null);
  const [name, setName] = useState("my-app");
  const list = dashboards.data ?? [];
  const selected = choice ?? list[0]?.id ?? NEW;
  const region = useConsoleStore((s) => s.region);

  const save = useMutation({
    mutationFn: async () => {
      const widget = widgetFor(spec!, region);
      const existing = list.find((d) => d.id === selected);
      if (existing) {
        const doc = JSON.parse(String(existing.config.body)) as { widgets: unknown[] };
        doc.widgets.push(widget);
        return (await api.updateResource(existing.id, { ...existing.config, body: JSON.stringify(doc, null, 2) })).item;
      }
      return (await api.createResource({ service: "cloudwatch", type: "dashboard", region, config: { name, body: JSON.stringify({ widgets: [widget] }, null, 2) } })).item;
    },
    onSuccess: (item) => {
      qc.invalidateQueries();
      toast.success(`Added to dashboard ${item.name}`, { action: { label: "Open", onClick: () => (window.location.href = routes.detail("cloudwatch", "dashboard", item.id)) } });
      onClose();
    },
  });

  return (
    <Dialog open={!!spec} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add “{spec?.title}” to a dashboard</DialogTitle>
          <DialogDescription>A dashboard is your own page of graphs, so you can watch several resources side by side.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Dashboard</Label>
            <Select value={selected} onValueChange={setChoice}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {list.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
                <SelectItem value={NEW}>Create new dashboard</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {selected === NEW && (
            <div className="space-y-1.5">
              <Label htmlFor="dash-name">New dashboard name</Label>
              <Input id="dash-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          {save.error && <p className="text-sm text-destructive">{save.error instanceof ApiError ? `${save.error.code}: ${save.error.message}` : String(save.error)}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || (selected === NEW && !name)}>
            Add to dashboard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- alarm ----------

interface HistoryItem {
  timestamp: string;
  summary: string;
  newState: string;
  reason: string;
}

export function AlarmStateBadge({ state }: { state: string }) {
  if (state === "ALARM")
    return (
      <Badge variant="destructive">
        <SirenIcon className="size-3" /> In alarm
      </Badge>
    );
  if (state === "OK")
    return (
      <Badge variant="success">
        <CheckCircle2Icon className="size-3" /> OK
      </Badge>
    );
  return (
    <Badge variant="secondary">
      <CircleHelpIcon className="size-3" /> Insufficient data
    </Badge>
  );
}

export function AlarmPanel({ alarm }: { alarm: ResourceDTO }) {
  const c = alarm.config as {
    namespace: string;
    metricName: string;
    dimensions?: { name: string; value: string }[];
    statistic: MetricQuery["stat"];
    period: number;
    threshold: number;
  };
  const a = alarm.attributes as { stateValue?: string; stateReason?: string; stateUpdatedTimestamp?: string; conditionText?: string; history?: HistoryItem[] };
  const [minutes, setMinutes] = useState(180);
  const query: MetricQuery = {
    id: "m",
    namespace: c.namespace,
    name: c.metricName,
    stat: c.statistic,
    dimensions: (c.dimensions ?? []).map((d) => ({ Name: d.name, Value: d.value })),
    period: Math.max(Number(c.period) || 60, autoPeriod(minutes)),
  };
  // The query key is compared by value, so a fresh array each render is fine.
  const metrics = useMetricSeries([query], minutes);
  const series = metrics.data?.series[0];
  const history = a.history ?? [];

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              {a.stateValue && <AlarmStateBadge state={a.stateValue} />}
              <span>{a.conditionText}</span>
              {series?.simulated && <SimulatedBadge />}
            </CardTitle>
            <CardDescription>
              {c.namespace} · {c.metricName}
              {query.dimensions.map((d) => ` · ${d.Name}=${d.Value}`).join("")}. Checked every minute.
            </CardDescription>
          </div>
          <RangePicker value={minutes} onChange={setMinutes} />
        </CardHeader>
        <CardContent className="space-y-3 pb-5">
          <MetricChart
            series={series}
            from={metrics.data?.from ?? 0}
            to={metrics.data?.to ?? 1}
            loading={metrics.isLoading}
            threshold={Number(c.threshold)}
            height={200}
            label={`${c.statistic} of ${c.metricName}`}
          />
          {a.stateReason && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p className="text-xs font-medium text-muted-foreground">
                Reason{a.stateUpdatedTimestamp && ` · ${formatDistanceToNowStrict(new Date(a.stateUpdatedTimestamp), { addSuffix: true })}`}
              </p>
              <p className="mt-1 font-mono text-xs break-words">{a.stateReason}</p>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>Every state change, newest first (describe-alarm-history).</CardDescription>
        </CardHeader>
        <CardContent className="py-2">
          {history.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No state changes yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">Time</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs tabular-nums">{new Date(h.timestamp).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" })}</TableCell>
                    <TableCell className="text-sm">{h.summary}</TableCell>
                    <TableCell className="max-w-md text-xs whitespace-normal text-muted-foreground">{h.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

// ---------- log group ----------

const ALL = "__all__";

export function LogGroupPanel({ group }: { group: ResourceDTO }) {
  const [minutes, setMinutes] = useState(60);
  const [stream, setStream] = useState(ALL);
  const [draft, setDraft] = useState("");
  const [pattern, setPattern] = useState("");
  const streams = useLogStreams(group.name);
  const events = useLogEvents(group.name, pattern, stream === ALL ? null : stream, minutes);
  const list = events.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <ScrollTextIcon className="size-4" /> Log events
          </CardTitle>
          <CardDescription>Like “aws logs tail”: new lines show up every few seconds.</CardDescription>
        </div>
        <RangePicker value={minutes} onChange={setMinutes} />
      </CardHeader>
      <CardContent className="space-y-3 pb-5">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setPattern(draft.trim());
          }}
        >
          <Select value={stream} onValueChange={setStream}>
            <SelectTrigger className="w-full sm:w-72" aria-label="Log stream">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All streams ({streams.data?.length ?? 0})</SelectItem>
              {(streams.data ?? []).map((s) => (
                <SelectItem key={s.stream} value={s.stream}>
                  {s.stream}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder='Filter pattern, e.g. ERROR   "payment declined"   ?ERROR ?WARN   -START'
            className="min-w-0 flex-1 font-mono text-xs"
            aria-label="Filter pattern"
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {events.error && <p className="text-sm text-destructive">{events.error instanceof ApiError ? `${events.error.code}: ${events.error.message}` : String(events.error)}</p>}
        {list.length === 0 && !events.isLoading ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            {pattern ? "No events match this pattern in the time range." : "No log events in this time range yet."}
          </p>
        ) : (
          <div className="max-h-[480px] overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="w-40 px-2 py-1.5 font-medium">Timestamp</th>
                  <th className="px-2 py-1.5 font-medium">Message</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.map((e) => (
                  <tr key={e.id} className={cn(/\b(ERROR|Error|Task timed out)\b/.test(e.message) && "bg-destructive/5")}>
                    <td className="px-2 py-1 align-top whitespace-nowrap tabular-nums text-muted-foreground" title={e.stream}>
                      {new Date(e.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.
                      {String(e.timestamp % 1000).padStart(3, "0")}
                    </td>
                    <td className="px-2 py-1 font-mono break-all whitespace-pre-wrap">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Same search in the terminal:{" "}
          <Link
            className="font-mono text-primary hover:underline"
            href={routes.terminalWith(`aws logs filter-log-events --log-group-name ${group.name}${pattern ? ` --filter-pattern '${pattern}'` : ""}`)}
          >
            aws logs filter-log-events --log-group-name {group.name}
            {pattern ? ` --filter-pattern '${pattern}'` : ""}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

/** On a function page: where its logs go, and why they might not. */
export function FunctionLogsCard({ fn }: { fn: ResourceDTO }) {
  const groups = useResources("logs", "log-group");
  const name = `/aws/lambda/${fn.name}`;
  const group = groups.data?.find((g) => g.name === name);
  const denied = fn.attributes.logsDenied as string | null | undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollTextIcon className="size-4" /> Logs
        </CardTitle>
        <CardDescription>
          Everything the function prints (console.log) goes to the log group <span className="font-mono">{name}</span>, with START, END and REPORT lines for each run.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pb-5">
        {denied && (
          <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <p>
              <span className="font-medium">Logs aren’t being saved.</span> {denied}
            </p>
          </div>
        )}
        {group ? (
          <Button asChild variant="outline" size="sm">
            <Link href={routes.detail("logs", "log-group", group.id)}>View logs in CloudWatch</Link>
          </Button>
        ) : (
          !denied && <p className="text-sm text-muted-foreground">The log group is created the first time the function runs.</p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- dashboard ----------

function WidgetChart({ widget, minutes, index }: { widget: DashboardWidget; minutes: number; index: number }) {
  const queries = useMemo(
    () =>
      widget.lines.map((l, i) => ({
        id: `w${index}-${i}`,
        namespace: l.namespace,
        name: l.name,
        dimensions: l.dimensions,
        stat: (l.stat ?? widget.stat) as MetricQuery["stat"],
        period: Math.max(widget.period, autoPeriod(minutes)),
      })),
    [widget, minutes, index],
  );
  const metrics = useMetricSeries(queries, minutes);
  return (
    <div className="space-y-3">
      {queries.map((q, i) => {
        const series = metrics.data?.series[i];
        const label = widget.lines[i].label ?? `${q.name}${q.dimensions.length ? ` (${q.dimensions.map((d) => d.Value).join(", ")})` : ""}`;
        if (widget.view === "singleValue") {
          const last = series?.points.at(-1);
          return (
            <div key={q.id}>
              <p className="text-xs text-muted-foreground">
                {label} · {q.stat}
              </p>
              <p className="text-3xl font-semibold tabular-nums">{last ? formatValue(last.v, series!.unit) : "–"}</p>
            </div>
          );
        }
        return (
          <div key={q.id}>
            {queries.length > 1 && (
              <p className="mb-0.5 text-xs text-muted-foreground">
                {label} · {q.stat}
              </p>
            )}
            <MetricChart series={series} from={metrics.data?.from ?? 0} to={metrics.data?.to ?? 1} loading={metrics.isLoading} height={queries.length > 1 ? 120 : 170} label={`${q.stat} of ${q.name}`} />
          </div>
        );
      })}
    </div>
  );
}

export function DashboardPanel({ dashboard }: { dashboard: ResourceDTO }) {
  const [minutes, setMinutes] = useState(180);
  const qc = useQueryClient();
  const body = String(dashboard.config.body ?? "");
  const widgets = useMemo(() => {
    try {
      return parseDashboardBody(body);
    } catch {
      return [];
    }
  }, [body]);
  const remove = useMutation({
    mutationFn: async (index: number) => {
      const doc = JSON.parse(body) as { widgets: unknown[] };
      doc.widgets.splice(index, 1);
      return api.updateResource(dashboard.id, { ...dashboard.config, body: JSON.stringify(doc, null, 2) });
    },
    onSuccess: () => qc.invalidateQueries(),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <LayoutDashboardIcon className="size-4" /> {dashboard.name}
          </CardTitle>
          <CardDescription>Graphs for the region selected at the top. Add more with “Add to dashboard” on any resource’s Monitoring card.</CardDescription>
        </div>
        <RangePicker value={minutes} onChange={setMinutes} />
      </CardHeader>
      <CardContent className="pb-5">
        {widgets.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            This dashboard is empty. Open a Lambda function, API or load balancer and use “Add to dashboard” under a graph.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-24">
            {widgets.map((w, i) => (
              <section
                key={i}
                className="min-w-0 rounded-md border p-3 lg:[grid-column:span_var(--span)/span_var(--span)]"
                style={{ "--span": w.width } as React.CSSProperties}
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h3 className="text-sm font-medium">{w.type === "text" ? "" : w.title}</h3>
                  <button
                    type="button"
                    aria-label={`Remove widget ${w.title}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => remove.mutate(i)}
                    disabled={remove.isPending}
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </div>
                {w.type === "text" ? <p className="text-sm whitespace-pre-wrap">{w.markdown}</p> : <WidgetChart widget={w} minutes={minutes} index={i} />}
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
