import { runAlarmActions } from "../sns/publish";
import type { Engine } from "../engine";
import type { Resource } from "../types";
import type { Statistic } from "./metrics";

/**
 * Alarm evaluation, like CloudWatch's: look at the last N complete periods
 * of the metric, count how many breach the threshold (M out of N), treat
 * missing datapoints as configured, and record each state change in the
 * alarm's history. No background jobs: alarms are evaluated whenever the
 * region is used, at most every 10 seconds.
 */

export type AlarmState = "OK" | "ALARM" | "INSUFFICIENT_DATA";

export interface HistoryItem {
  timestamp: string;
  type: "StateUpdate" | "ConfigurationUpdate" | "Action";
  summary: string;
  oldState?: AlarmState;
  newState?: AlarmState;
  reason?: string;
}

const breaches = (op: string, v: number, t: number) =>
  op === "GreaterThanThreshold" ? v > t : op === "GreaterThanOrEqualToThreshold" ? v >= t : op === "LessThanThreshold" ? v < t : v <= t;

const OP_WORDS: Record<string, string> = {
  GreaterThanThreshold: "greater than",
  GreaterThanOrEqualToThreshold: "greater than or equal to",
  LessThanThreshold: "less than",
  LessThanOrEqualToThreshold: "less than or equal to",
};

const fmt = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(2)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

export interface Evaluation {
  state: AlarmState | null;
  reason: string;
  values: { timestamp: string; value: number | null }[];
}

/** Evaluates one alarm against its metric (without saving anything). */
export async function evaluateAlarm(engine: Engine, alarm: Resource, now: Date): Promise<Evaluation> {
  const c = alarm.config;
  const periodMs = Number(c.period) * 1000;
  const n = Number(c.evaluationPeriods);
  const m = Number(c.datapointsToAlarm ?? n);
  const end = Math.floor(now.getTime() / periodMs) * periodMs; // only complete periods
  const start = end - n * periodMs;
  const stat = String(c.statistic) as Statistic;
  const dims = ((c.dimensions as { name: string; value: string }[] | undefined) ?? []).map((d) => ({ Name: d.name, Value: d.value }));
  const datapoints = await engine.metrics.statistics(alarm.accountId, alarm.region, {
    namespace: String(c.namespace),
    name: String(c.metricName),
    dimensions: dims,
    start: new Date(start),
    end: new Date(end),
    period: Number(c.period),
    statistics: [stat],
  });
  const byTime = new Map(datapoints.map((d) => [Date.parse(d.Timestamp), d[stat] as number]));
  const values = Array.from({ length: n }, (_, i) => {
    const t = end - (i + 1) * periodMs;
    return { timestamp: new Date(t).toISOString(), value: byTime.has(t) ? byTime.get(t)! : null };
  });
  const threshold = Number(c.threshold);
  const op = String(c.comparisonOperator);
  const present = values.filter((v) => v.value !== null);
  const missing = n - present.length;
  const treat = String(c.treatMissingData ?? "missing");

  if (present.length === 0) {
    if (treat === "ignore") return { state: null, reason: "No datapoints; keeping the current state (treat missing data: ignore).", values };
    if (treat === "notBreaching") return { state: "OK", reason: `Threshold Crossed: no datapoints were received for ${n} period${n > 1 ? "s" : ""} and ${n} missing datapoint${n > 1 ? "s were" : " was"} treated as [NonBreaching].`, values };
    if (treat === "breaching") return { state: "ALARM", reason: `Threshold Crossed: no datapoints were received for ${n} period${n > 1 ? "s" : ""} and ${n} missing datapoint${n > 1 ? "s were" : " was"} treated as [Breaching].`, values };
    return { state: "INSUFFICIENT_DATA", reason: `Insufficient Data: ${n} datapoint${n > 1 ? "s were" : " was"} unknown.`, values };
  }

  let breaching = present.filter((v) => breaches(op, v.value!, threshold)).length;
  if (treat === "breaching") breaching += missing;
  const shown = present
    .slice(0, 5)
    .map((v) => `${+v.value!.toFixed(4)} (${fmt(new Date(v.timestamp))})`)
    .join(", ");
  const verb = OP_WORDS[op] ?? op;
  if (breaching >= m) {
    return {
      state: "ALARM",
      reason: `Threshold Crossed: ${breaching} out of the last ${n} datapoints [${shown}] ${breaching === 1 ? "was" : "were"} ${verb} the threshold (${threshold}) (minimum ${m} datapoint${m > 1 ? "s" : ""} for OK -> ALARM transition).`,
      values,
    };
  }
  if (treat === "missing" && present.length < m && breaching < m) {
    // Not enough data to know: CloudWatch keeps waiting rather than declaring OK.
    const okPossible = present.length - breaching >= n - m + 1;
    if (!okPossible) return { state: null, reason: "Not enough datapoints yet.", values };
  }
  return {
    state: "OK",
    reason: `Threshold Crossed: ${present.length - breaching} out of the last ${n} datapoints [${shown}] ${present.length - breaching === 1 ? "was" : "were"} not ${verb} the threshold (${threshold}) (minimum ${n - m + 1} datapoint${n - m + 1 > 1 ? "s" : ""} for ALARM -> OK transition).`,
    values,
  };
}

/** Saves a state change (or a manual one from set-alarm-state) with its history entry. */
export async function changeState(engine: Engine, alarm: Resource, state: AlarmState, reason: string, now: Date, extra: Record<string, unknown> = {}) {
  const old = alarm.attributes.stateValue as AlarmState;
  const history = (alarm.attributes.history as HistoryItem[] | undefined) ?? [];
  const entry: HistoryItem = {
    timestamp: now.toISOString(),
    type: "StateUpdate",
    summary: `Alarm updated from ${old} to ${state}`,
    oldState: old,
    newState: state,
    reason,
  };
  await engine.setAttributes(alarm.accountId, alarm.id, {
    stateValue: state,
    stateReason: reason,
    stateUpdatedTimestamp: now.toISOString(),
    history: old === state ? history : [entry, ...history].slice(0, 50),
    ...extra,
  });
  // Notifications: an alarm's actions run when its state changes.
  if (old !== state) await runAlarmActions(engine, alarm, old, state, reason, now.toISOString());
}

export async function evaluateAlarms(engine: Engine, accountId: string, region: string, now: Date) {
  const key = `alarms:${accountId}:${region}:${Math.floor(now.getTime() / 10_000)}`;
  if (!(await engine.lock(key))) return;
  try {
    const alarms = await engine.list(accountId, { service: "cloudwatch", type: "alarm", region });
    for (const alarm of alarms) {
      // A state set by hand (set-alarm-state) holds until the next period's evaluation.
      const manualUntil = alarm.attributes.manualUntil ? Date.parse(String(alarm.attributes.manualUntil)) : 0;
      if (now.getTime() < manualUntil) continue;
      const ev = await evaluateAlarm(engine, alarm, now);
      if (ev.state && ev.state !== alarm.attributes.stateValue) {
        await changeState(engine, alarm, ev.state, ev.reason, now, { manualUntil: null, evaluatedAt: now.toISOString() });
      } else {
        await engine.setAttributes(accountId, alarm.id, { evaluatedAt: now.toISOString(), manualUntil: null, ...(ev.state ? { stateReason: ev.reason } : {}) });
      }
    }
  } finally {
    await engine.unlock(key);
  }
}
