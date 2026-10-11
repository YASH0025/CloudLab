import type { Engine } from "@/engine/engine";
import { parseDashboardBody } from "@/engine/services/cloudwatch";
import type { Resource } from "@/engine/types";

/** The function the monitoring tutorial watches. */
export const WATCHED_FUNCTION = "orders";

/** What the monitoring tutorial looks at: the orders function, its logs, an alarm on its errors and a dashboard. */
export interface WatchState {
  fn?: Resource;
  logGroup?: Resource;
  hasLogEvents: boolean;
  hasMetrics: boolean;
  /** An alarm on the function's Errors metric. */
  alarm?: Resource;
  /** Whether that alarm has been in ALARM at least once. */
  alarmFired: boolean;
  /** A dashboard with a graph of the function. */
  dashboard?: Resource;
}

const dims = (r: Resource) => (r.config.dimensions as { name: string; value: string }[] | undefined) ?? [];

export async function loadWatch(engine: Engine, accountId: string, region: string): Promise<WatchState> {
  const list = (service: string, type: string) => engine.list(accountId, { service, type, region });
  const [fns, groups, alarms, dashboards] = await Promise.all([
    list("lambda", "function"),
    list("logs", "log-group"),
    list("cloudwatch", "alarm"),
    engine.list(accountId, { service: "cloudwatch", type: "dashboard", region: "global" }),
  ]);
  const fn = fns.find((f) => f.name === WATCHED_FUNCTION);
  const name = fn?.name ?? WATCHED_FUNCTION;
  const logGroup = groups.find((g) => g.name === `/aws/lambda/${name}`);
  const [streams, metrics] = await Promise.all([
    logGroup ? engine.logs.streams(accountId, region, logGroup.name) : Promise.resolve([]),
    fn ? engine.metrics.list(accountId, region, { namespace: "AWS/Lambda", name: "Invocations", dimensions: [{ Name: "FunctionName", Value: name }] }) : Promise.resolve([]),
  ]);
  const alarm = alarms.find(
    (a) => a.config.namespace === "AWS/Lambda" && a.config.metricName === "Errors" && dims(a).some((d) => d.name === "FunctionName" && d.value === name),
  );
  const history = (alarm?.attributes.history as { newState: string }[] | undefined) ?? [];
  const dashboard = dashboards.find((d) => {
    try {
      return parseDashboardBody(String(d.config.body)).some((w) => w.lines.some((l) => l.dimensions.some((x) => x.Name === "FunctionName" && x.Value === name)));
    } catch {
      return false;
    }
  });
  return {
    fn,
    logGroup,
    hasLogEvents: streams.length > 0,
    hasMetrics: metrics.length > 0,
    alarm,
    alarmFired: alarm?.attributes.stateValue === "ALARM" || history.some((h) => h.newState === "ALARM"),
    dashboard,
  };
}
