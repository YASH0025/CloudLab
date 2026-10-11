import { EngineError } from "@/engine/errors";
import { changeState, type AlarmState, type HistoryItem } from "@/engine/telemetry/alarms";
import { parseDimKey, STATISTICS, type Dimension, type Statistic } from "@/engine/telemetry/metrics";
import { RETENTION_DAYS } from "@/engine/services/logs";
import type { Resource } from "@/engine/types";
import type { Args, CliContext, Command } from "./commands";
import { LocalPathError, parseShorthand, UsageError } from "./parse";

/**
 * `aws cloudwatch` (metrics, alarms, dashboards) and `aws logs`.
 * Times: metrics take ISO 8601 or epoch seconds; Logs takes epoch milliseconds, as in AWS.
 */

const cmd = (c: Command) => c;

const listType = (ctx: CliContext, type: string) =>
  ctx.engine.list(ctx.accountId, { service: type === "log-group" ? "logs" : "cloudwatch", type, region: type === "dashboard" ? "global" : ctx.region });

/** file://… or an inline value. */
function textArg(ctx: CliContext, value: string): string {
  const m = /^fileb?:\/\/(.+)$/.exec(value);
  if (!m) return value;
  const data = ctx.files?.[m[1]];
  if (data === undefined) throw new LocalPathError(m[1]);
  return Buffer.from(data, "base64").toString("utf8");
}

/** --dimensions Name=X,Value=Y ... or X=Y (put-metric-data's short form). */
function dimsArg(args: Args, option = "dimensions"): Dimension[] {
  return args.raw(option).flatMap((raw) => {
    const t = raw.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      const v = JSON.parse(t);
      return (Array.isArray(v) ? v : [v]) as Dimension[];
    }
    const parsed = parseShorthand(t) as Record<string, string>;
    if ("Name" in parsed) return [{ Name: String(parsed.Name), Value: parsed.Value === undefined ? "" : String(parsed.Value) }];
    return Object.entries(parsed).map(([Name, Value]) => ({ Name, Value: String(Value) }));
  });
}

function timeArg(value: string | undefined, name: string, unit: "s" | "ms" = "s"): Date | undefined {
  if (value === undefined) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return new Date(Number(value) * (unit === "s" ? 1000 : 1));
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new UsageError(`argument --${name}: Unable to parse the date '${value}'`);
  return d;
}

const num = (args: Args, name: string): number | undefined => {
  const v = args.one(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`argument --${name}: invalid value: '${v}'`);
  return n;
};

// ---------- alarms ----------

function alarmOut(a: Resource) {
  const c = a.config;
  const at = a.attributes;
  return {
    AlarmName: a.name,
    AlarmArn: a.id,
    ...(c.description ? { AlarmDescription: c.description } : {}),
    AlarmConfigurationUpdatedTimestamp: at.alarmConfigurationUpdatedTimestamp,
    ActionsEnabled: c.actionsEnabled !== false,
    OKActions: [],
    AlarmActions: (at.alarmActions as string[] | undefined) ?? [],
    InsufficientDataActions: [],
    StateValue: at.stateValue,
    StateReason: at.stateReason,
    StateUpdatedTimestamp: at.stateUpdatedTimestamp,
    MetricName: c.metricName,
    Namespace: c.namespace,
    Statistic: c.statistic,
    Dimensions: ((c.dimensions as { name: string; value: string }[] | undefined) ?? []).map((d) => ({ Name: d.name, Value: d.value })),
    Period: c.period,
    EvaluationPeriods: c.evaluationPeriods,
    ...(c.datapointsToAlarm ? { DatapointsToAlarm: c.datapointsToAlarm } : {}),
    Threshold: c.threshold,
    ComparisonOperator: c.comparisonOperator,
    TreatMissingData: c.treatMissingData,
    StateTransitionedTimestamp: at.stateUpdatedTimestamp,
  };
}

async function alarmByName(ctx: CliContext, name: string): Promise<Resource> {
  const a = (await listType(ctx, "alarm")).find((x) => x.name === name);
  if (!a) throw new EngineError("ResourceNotFound", `Alarm ${name} does not exist.`, 404);
  return a;
}

// ---------- logs ----------

async function groupByName(ctx: CliContext, name: string): Promise<Resource> {
  const g = (await listType(ctx, "log-group")).find((x) => x.name === name);
  if (!g) throw new EngineError("ResourceNotFoundException", "The specified log group does not exist.", 400);
  return g;
}

/** --since 10m / 2h / 1d / 1w, or an ISO time. */
function sinceArg(value: string | undefined, now: Date): number {
  if (!value) return now.getTime() - 10 * 60_000;
  const m = /^(\d+)(s|m|h|d|w)$/.exec(value);
  if (m) return now.getTime() - Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "s"];
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new UsageError(`argument --since: Unable to parse '${value}' (use e.g. 10m, 2h, 1d or an ISO time)`);
  return d.getTime();
}

const isoMicros = (ms: number) => new Date(ms).toISOString().replace("Z", "000+00:00");

export const CLOUDWATCH_COMMANDS: Command[] = [
  // --- metrics ---
  cmd({
    service: "cloudwatch",
    operation: "put-metric-data",
    apiName: "PutMetricData",
    summary: "Publish your own metric datapoints",
    usage: "--namespace <name> --metric-name <name> --value <number> [--unit <unit>] [--dimensions <Name=Value,...>] [--timestamp <time>] | --metric-data <json>",
    mutates: true,
    async run(args, ctx) {
      const namespace = args.required("namespace");
      let items: { name: string; dimensions: Dimension[]; value: number; unit?: string; timestamp?: Date }[];
      const data = args.one("metric-data");
      if (data) {
        const parsed = JSON.parse(textArg(ctx, data)) as { MetricName: string; Value: number; Unit?: string; Dimensions?: Dimension[]; Timestamp?: string }[];
        items = parsed.map((d) => ({ name: d.MetricName, value: Number(d.Value), unit: d.Unit, dimensions: d.Dimensions ?? [], timestamp: d.Timestamp ? new Date(d.Timestamp) : undefined }));
      } else {
        const value = num(args, "value");
        if (value === undefined) throw new UsageError("the following arguments are required: --value (or --metric-data)");
        items = [{ name: args.required("metric-name"), value, unit: args.one("unit"), dimensions: dimsArg(args), timestamp: timeArg(args.one("timestamp"), "timestamp") }];
      }
      await ctx.engine.metrics.putData(ctx.accountId, ctx.region, namespace, items);
    },
  }),
  cmd({
    service: "cloudwatch",
    operation: "get-metric-statistics",
    apiName: "GetMetricStatistics",
    summary: "Get a metric's statistics per period",
    usage:
      "--namespace <name> --metric-name <name> [--dimensions Name=<n>,Value=<v> ...] --start-time <time> --end-time <time> --period <seconds> --statistics <Sum|Average|Minimum|Maximum|SampleCount> ...",
    mutates: false,
    async run(args, ctx) {
      const statistics = args.list("statistics") as Statistic[];
      const bad = statistics.find((s) => !STATISTICS.includes(s));
      if (bad) throw new EngineError("InvalidParameterValue", `The parameter Statistics.member.1 must be a value in the set [ Maximum, Sum, SampleCount, Minimum, Average ].`);
      const start = timeArg(args.required("start-time"), "start-time")!;
      const end = timeArg(args.required("end-time"), "end-time")!;
      const period = num(args, "period");
      if (period === undefined) throw new UsageError("the following arguments are required: --period");
      const name = args.required("metric-name");
      const datapoints = await ctx.engine.metrics.statistics(ctx.accountId, ctx.region, {
        namespace: args.required("namespace"),
        name,
        dimensions: dimsArg(args),
        start,
        end,
        period,
        statistics,
      });
      return { Label: name, Datapoints: datapoints };
    },
  }),
  cmd({
    service: "cloudwatch",
    operation: "list-metrics",
    apiName: "ListMetrics",
    summary: "List metrics that have data",
    usage: "[--namespace <name>] [--metric-name <name>] [--dimensions Name=<n>[,Value=<v>] ...]",
    mutates: false,
    async run(args, ctx) {
      const items = await ctx.engine.metrics.list(ctx.accountId, ctx.region, {
        namespace: args.one("namespace"),
        name: args.one("metric-name"),
        dimensions: dimsArg(args),
      });
      return { Metrics: items.map((m) => ({ Namespace: m.namespace, MetricName: m.name, Dimensions: parseDimKey(m.dimensions) })) };
    },
  }),

  // --- alarms ---
  cmd({
    service: "cloudwatch",
    operation: "put-metric-alarm",
    apiName: "PutMetricAlarm",
    summary: "Create or update an alarm on a metric",
    usage:
      "--alarm-name <name> --namespace <ns> --metric-name <name> --statistic <stat> --period <seconds> --evaluation-periods <n> --threshold <number> --comparison-operator <op> [--dimensions Name=<n>,Value=<v> ...] [--datapoints-to-alarm <m>] [--treat-missing-data <missing|notBreaching|breaching|ignore>] [--alarm-description <text>] [--alarm-actions <arn> ...]",
    mutates: true,
    async run(args, ctx) {
      const name = args.required("alarm-name");
      const config = {
        name,
        description: args.one("alarm-description"),
        namespace: args.required("namespace"),
        metricName: args.required("metric-name"),
        dimensions: dimsArg(args).map((d) => ({ name: d.Name, value: d.Value })),
        statistic: args.required("statistic"),
        period: num(args, "period"),
        evaluationPeriods: num(args, "evaluation-periods"),
        datapointsToAlarm: num(args, "datapoints-to-alarm"),
        threshold: num(args, "threshold"),
        comparisonOperator: args.required("comparison-operator"),
        treatMissingData: args.one("treat-missing-data") ?? "missing",
        actionsEnabled: args.bool("actions-enabled") ?? true,
      };
      const existing = (await listType(ctx, "alarm")).find((a) => a.name === name);
      const saved = existing
        ? await ctx.engine.update(ctx.accountId, existing.id, config)
        : await ctx.engine.create(ctx.accountId, { service: "cloudwatch", type: "alarm", region: ctx.region, config });
      const actions = args.list("alarm-actions");
      if (actions.length) await ctx.engine.setAttributes(ctx.accountId, saved.id, { alarmActions: actions });
      // A new or changed alarm is checked straight away.
      await ctx.engine.ensureDefaults(ctx.accountId, ctx.region);
    },
  }),
  cmd({
    service: "cloudwatch",
    operation: "describe-alarms",
    apiName: "DescribeAlarms",
    summary: "List alarms and their state",
    usage: "[--alarm-names <name> ...] [--alarm-name-prefix <prefix>] [--state-value OK|ALARM|INSUFFICIENT_DATA]",
    mutates: false,
    async run(args, ctx) {
      const names = args.list("alarm-names");
      const prefix = args.one("alarm-name-prefix");
      const state = args.one("state-value");
      const items = (await listType(ctx, "alarm"))
        .filter((a) => (!names.length || names.includes(a.name)) && (!prefix || a.name.startsWith(prefix)) && (!state || a.attributes.stateValue === state))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { MetricAlarms: items.map(alarmOut), CompositeAlarms: [] };
    },
  }),
  cmd({
    service: "cloudwatch",
    operation: "delete-alarms",
    apiName: "DeleteAlarms",
    summary: "Delete alarms",
    usage: "--alarm-names <name> ...",
    mutates: true,
    async run(args, ctx) {
      const names = args.list("alarm-names");
      if (!names.length) throw new UsageError("the following arguments are required: --alarm-names");
      const all = await listType(ctx, "alarm");
      const missing = names.filter((n) => !all.some((a) => a.name === n));
      if (missing.length) throw new EngineError("ResourceNotFound", `${missing.length} alarms not found`, 404);
      for (const a of all.filter((x) => names.includes(x.name))) await ctx.engine.remove(ctx.accountId, a.id);
    },
  }),
  cmd({
    service: "cloudwatch",
    operation: "set-alarm-state",
    apiName: "SetAlarmState",
    summary: "Force an alarm's state for testing (it's re-evaluated at the next period)",
    usage: "--alarm-name <name> --state-value OK|ALARM|INSUFFICIENT_DATA --state-reason <text>",
    mutates: true,
    async run(args, ctx) {
      const alarm = await alarmByName(ctx, args.required("alarm-name"));
      const state = args.required("state-value") as AlarmState;
      if (!["OK", "ALARM", "INSUFFICIENT_DATA"].includes(state)) {
        throw new EngineError("InvalidParameterValue", "The parameter StateValue must be a value in the set [ OK, ALARM, INSUFFICIENT_DATA ].");
      }
      const now = ctx.engine.now();
      await changeState(ctx.engine, alarm, state, args.required("state-reason"), now, {
        manualUntil: new Date(now.getTime() + Number(alarm.config.period) * 1000).toISOString(),
      });
    },
  }),
  cmd({
    service: "cloudwatch",
    operation: "describe-alarm-history",
    apiName: "DescribeAlarmHistory",
    summary: "Show an alarm's state changes and updates",
    usage: "[--alarm-name <name>] [--history-item-type StateUpdate|ConfigurationUpdate] [--max-records <n>]",
    mutates: false,
    async run(args, ctx) {
      const name = args.one("alarm-name");
      const type = args.one("history-item-type");
      const alarms = name ? [await alarmByName(ctx, name)] : await listType(ctx, "alarm");
      const items = alarms
        .flatMap((a) =>
          ((a.attributes.history as HistoryItem[] | undefined) ?? []).map((h) => ({
            AlarmName: a.name,
            AlarmType: "MetricAlarm",
            Timestamp: h.timestamp,
            HistoryItemType: h.type,
            HistorySummary: h.summary,
            ...(h.type === "StateUpdate"
              ? {
                  HistoryData: JSON.stringify({
                    version: "1.0",
                    oldState: { stateValue: h.oldState },
                    newState: { stateValue: h.newState, stateReason: h.reason },
                  }),
                }
              : {}),
          })),
        )
        .filter((h) => !type || h.HistoryItemType === type)
        .sort((a, b) => b.Timestamp.localeCompare(a.Timestamp));
      const max = num(args, "max-records");
      return { AlarmHistoryItems: max ? items.slice(0, max) : items };
    },
  }),

  // --- dashboards ---
  cmd({
    service: "cloudwatch",
    operation: "put-dashboard",
    apiName: "PutDashboard",
    summary: "Create or replace a dashboard from a JSON body",
    usage: "--dashboard-name <name> --dashboard-body <json|file://dashboard.json>",
    mutates: true,
    async run(args, ctx) {
      const name = args.required("dashboard-name");
      const body = textArg(ctx, args.required("dashboard-body"));
      const existing = (await listType(ctx, "dashboard")).find((d) => d.name === name);
      if (existing) await ctx.engine.update(ctx.accountId, existing.id, { body });
      else await ctx.engine.create(ctx.accountId, { service: "cloudwatch", type: "dashboard", region: "global", config: { name, body } });
      return { DashboardValidationMessages: [] };
    },
  }),
  cmd({
    service: "cloudwatch",
    operation: "get-dashboard",
    apiName: "GetDashboard",
    summary: "Show a dashboard's body",
    usage: "--dashboard-name <name>",
    mutates: false,
    async run(args, ctx) {
      const name = args.required("dashboard-name");
      const d = (await listType(ctx, "dashboard")).find((x) => x.name === name);
      if (!d) throw new EngineError("ResourceNotFound", "Dashboard does not exist", 404);
      return { DashboardArn: d.id, DashboardBody: d.config.body, DashboardName: d.name };
    },
  }),
  cmd({
    service: "cloudwatch",
    operation: "list-dashboards",
    apiName: "ListDashboards",
    summary: "List dashboards",
    mutates: false,
    async run(_args, ctx) {
      return {
        DashboardEntries: (await listType(ctx, "dashboard")).map((d) => ({
          DashboardName: d.name,
          DashboardArn: d.id,
          LastModified: d.updatedAt,
          Size: String(d.config.body).length,
        })),
      };
    },
  }),
  cmd({
    service: "cloudwatch",
    operation: "delete-dashboards",
    apiName: "DeleteDashboards",
    summary: "Delete dashboards",
    usage: "--dashboard-names <name> ...",
    mutates: true,
    async run(args, ctx) {
      const names = args.list("dashboard-names");
      const all = await listType(ctx, "dashboard");
      const missing = names.filter((n) => !all.some((d) => d.name === n));
      if (missing.length) throw new EngineError("ResourceNotFound", `The specified dashboard does not exist. [${missing.join(", ")}]`, 404);
      for (const d of all.filter((x) => names.includes(x.name))) await ctx.engine.remove(ctx.accountId, d.id);
    },
  }),
];

export const LOGS_COMMANDS: Command[] = [
  cmd({
    service: "logs",
    operation: "create-log-group",
    apiName: "CreateLogGroup",
    summary: "Create a log group",
    usage: "--log-group-name <name>",
    mutates: true,
    async run(args, ctx) {
      await ctx.engine.create(ctx.accountId, { service: "logs", type: "log-group", region: ctx.region, config: { name: args.required("log-group-name") } });
    },
  }),
  cmd({
    service: "logs",
    operation: "describe-log-groups",
    apiName: "DescribeLogGroups",
    summary: "List log groups",
    usage: "[--log-group-name-prefix <prefix>]",
    mutates: false,
    async run(args, ctx) {
      const prefix = args.one("log-group-name-prefix");
      const groups = (await listType(ctx, "log-group")).filter((g) => !prefix || g.name.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name));
      return {
        logGroups: await Promise.all(
          groups.map(async (g) => {
            const streams = await ctx.engine.logs.streams(ctx.accountId, ctx.region, g.name);
            return {
              logGroupName: g.name,
              creationTime: g.attributes.creationTime,
              ...(g.config.retentionInDays !== "never" ? { retentionInDays: Number(g.config.retentionInDays) } : {}),
              metricFilterCount: 0,
              arn: `${g.id}:*`,
              storedBytes: streams.reduce((n, s) => n + s.storedBytes, 0),
              logGroupClass: "STANDARD",
              logGroupArn: g.id,
            };
          }),
        ),
      };
    },
  }),
  cmd({
    service: "logs",
    operation: "delete-log-group",
    apiName: "DeleteLogGroup",
    summary: "Delete a log group and its events",
    usage: "--log-group-name <name>",
    mutates: true,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("log-group-name"));
      await ctx.engine.remove(ctx.accountId, g.id);
    },
  }),
  cmd({
    service: "logs",
    operation: "put-retention-policy",
    apiName: "PutRetentionPolicy",
    summary: "Delete a group's events after some days",
    usage: "--log-group-name <name> --retention-in-days <days>",
    mutates: true,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("log-group-name"));
      const days = args.required("retention-in-days");
      if (!RETENTION_DAYS.includes(Number(days))) {
        throw new EngineError(
          "InvalidParameterException",
          `1 validation error detected: Value '${days}' at 'retentionInDays' failed to satisfy constraint: Member must satisfy enum value set: [${RETENTION_DAYS.join(", ")}]`,
        );
      }
      await ctx.engine.update(ctx.accountId, g.id, { retentionInDays: String(Number(days)) });
    },
  }),
  cmd({
    service: "logs",
    operation: "delete-retention-policy",
    apiName: "DeleteRetentionPolicy",
    summary: "Keep a group's events forever",
    usage: "--log-group-name <name>",
    mutates: true,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("log-group-name"));
      await ctx.engine.update(ctx.accountId, g.id, { retentionInDays: "never" });
    },
  }),
  cmd({
    service: "logs",
    operation: "create-log-stream",
    apiName: "CreateLogStream",
    summary: "Create a log stream in a group",
    usage: "--log-group-name <name> --log-stream-name <name>",
    mutates: true,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("log-group-name"));
      const stream = args.required("log-stream-name");
      const created = (g.attributes.createdStreams as string[] | undefined) ?? [];
      const existing = (await ctx.engine.logs.streams(ctx.accountId, ctx.region, g.name)).map((s) => s.stream);
      if (created.includes(stream) || existing.includes(stream)) throw new EngineError("ResourceAlreadyExistsException", "The specified log stream already exists", 400);
      await ctx.engine.setAttributes(ctx.accountId, g.id, { createdStreams: [...created, stream] });
    },
  }),
  cmd({
    service: "logs",
    operation: "describe-log-streams",
    apiName: "DescribeLogStreams",
    summary: "List a group's streams, newest first with --order-by LastEventTime --descending",
    usage: "--log-group-name <name> [--log-stream-name-prefix <prefix>] [--order-by LogStreamName|LastEventTime] [--descending] [--limit <n>]",
    mutates: false,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("log-group-name"));
      const prefix = args.one("log-stream-name-prefix");
      const withEvents = await ctx.engine.logs.streams(ctx.accountId, ctx.region, g.name);
      const empty = ((g.attributes.createdStreams as string[] | undefined) ?? []).filter((s) => !withEvents.some((w) => w.stream === s));
      let items = [
        ...withEvents.map((s) => ({
          logStreamName: s.stream,
          creationTime: s.firstEventTimestamp,
          firstEventTimestamp: s.firstEventTimestamp,
          lastEventTimestamp: s.lastEventTimestamp,
          lastIngestionTime: s.lastIngestionTime,
          arn: `${g.id}:log-stream:${s.stream}`,
          storedBytes: 0,
        })),
        ...empty.map((s) => ({ logStreamName: s, creationTime: Number(g.attributes.creationTime), arn: `${g.id}:log-stream:${s}`, storedBytes: 0 })),
      ].filter((s) => !prefix || s.logStreamName.startsWith(prefix));
      const byTime = args.one("order-by") === "LastEventTime";
      items.sort((a, b) =>
        byTime ? ((a as { lastEventTimestamp?: number }).lastEventTimestamp ?? 0) - ((b as { lastEventTimestamp?: number }).lastEventTimestamp ?? 0) : a.logStreamName.localeCompare(b.logStreamName),
      );
      if (args.bool("descending")) items.reverse();
      const limit = num(args, "limit");
      if (limit) items = items.slice(0, limit);
      return { logStreams: items };
    },
  }),
  cmd({
    service: "logs",
    operation: "put-log-events",
    apiName: "PutLogEvents",
    summary: "Write events to a log stream",
    usage: "--log-group-name <name> --log-stream-name <name> --log-events timestamp=<ms>,message=<text> ...",
    mutates: true,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("log-group-name"));
      const stream = args.required("log-stream-name");
      const known = [...((g.attributes.createdStreams as string[] | undefined) ?? []), ...(await ctx.engine.logs.streams(ctx.accountId, ctx.region, g.name)).map((s) => s.stream)];
      if (!known.includes(stream)) throw new EngineError("ResourceNotFoundException", "The specified log stream does not exist.", 400);
      const raw = args.raw("log-events");
      if (!raw.length) throw new UsageError("the following arguments are required: --log-events");
      const events = raw.flatMap((r) => {
        const t = textArg(ctx, r).trim();
        if (t.startsWith("[") || t.startsWith("{")) {
          const v = JSON.parse(t);
          return (Array.isArray(v) ? v : [v]) as { timestamp: number; message: string }[];
        }
        const m = /^timestamp=(\d+),message=([\s\S]*)$/.exec(t);
        if (!m) throw new UsageError(`Error parsing parameter '--log-events': Expected: 'timestamp=<ms>,message=<text>', received: '${t}'`);
        return [{ timestamp: Number(m[1]), message: m[2] }];
      });
      await ctx.engine.logs.put(ctx.accountId, ctx.region, g.name, stream, events.map((e) => ({ timestamp: Number(e.timestamp), message: String(e.message) })));
    },
  }),
  cmd({
    service: "logs",
    operation: "get-log-events",
    apiName: "GetLogEvents",
    summary: "Read a log stream",
    usage: "--log-group-name <name> --log-stream-name <name> [--start-time <ms>] [--end-time <ms>] [--limit <n>] [--start-from-head] [--next-token <token>]",
    mutates: false,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("log-group-name"));
      const stream = args.required("log-stream-name");
      const fromHead = args.bool("start-from-head") === true;
      const page = await ctx.engine.logs.events(ctx.accountId, ctx.region, g.name, {
        streams: [stream],
        from: num(args, "start-time"),
        to: num(args, "end-time"),
        limit: num(args, "limit") ?? 10_000,
        startFromHead: fromHead,
        nextToken: args.one("next-token"),
      });
      const events = fromHead ? page.events : [...page.events].reverse();
      const token = page.nextToken ?? `${fromHead ? "f" : "b"}/${events.at(-1)?.id ?? 0}`;
      return {
        events: events.map((e) => ({ timestamp: e.timestamp, message: e.message, ingestionTime: e.ingestedAt })),
        nextForwardToken: token.replace(/^b\//, "f/"),
        nextBackwardToken: token.replace(/^f\//, "b/"),
      };
    },
  }),
  cmd({
    service: "logs",
    operation: "filter-log-events",
    apiName: "FilterLogEvents",
    summary: "Search a log group with a filter pattern (ERROR, \"exact phrase\", ?A ?B, { $.level = \"error\" })",
    usage: "--log-group-name <name> [--filter-pattern <pattern>] [--log-stream-names <name> ...] [--start-time <ms>] [--end-time <ms>] [--limit <n>]",
    mutates: false,
    async run(args, ctx) {
      const g = await groupByName(ctx, args.required("log-group-name"));
      const streams = args.list("log-stream-names");
      const events = await ctx.engine.logs.filter(ctx.accountId, ctx.region, g.name, {
        pattern: args.one("filter-pattern"),
        streams,
        from: num(args, "start-time"),
        to: num(args, "end-time"),
        limit: num(args, "limit"),
      });
      return {
        events: events.map((e) => ({ logStreamName: e.stream, timestamp: e.timestamp, message: e.message, ingestionTime: e.ingestedAt, eventId: String(e.id).padStart(56, "0") })),
        searchedLogStreams: [],
      };
    },
  }),
  cmd({
    service: "logs",
    operation: "tail",
    apiName: "FilterLogEvents",
    summary: "Show a log group's recent events (aws logs tail /aws/lambda/hello --since 1h)",
    usage: "<log-group-name> [--since <10m|1h|1d|time>] [--filter-pattern <pattern>] [--format <detailed|short|json>] [--follow]",
    mutates: false,
    async run(args, ctx) {
      const name = args.positionals[0];
      if (!name) throw new UsageError("the following arguments are required: group_name");
      const g = await groupByName(ctx, name);
      const format = args.one("format") ?? "detailed";
      const events = await ctx.engine.logs.filter(ctx.accountId, ctx.region, g.name, {
        pattern: args.one("filter-pattern"),
        from: sinceArg(args.one("since"), ctx.engine.now()),
      });
      const lines = events.map((e) => {
        if (format === "short") return `${new Date(e.timestamp).toISOString().slice(0, 19)} ${e.message}`;
        if (format === "json") return JSON.stringify({ timestamp: e.timestamp, logStreamName: e.stream, message: e.message });
        return `${isoMicros(e.timestamp)} ${e.stream} ${e.message}`;
      });
      if (args.has("follow")) lines.push("(CloudLab: --follow doesn't keep running here. Run the command again to see new events.)");
      return lines.join("\n");
    },
  }),
];
