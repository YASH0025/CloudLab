import { createHash } from "node:crypto";
import type { Engine } from "../engine";
import { EngineError } from "../errors";
import type { ResourceStore } from "../store";
import { systemOf, type Resource } from "../types";
import type { MetricId, MetricPoint } from "./types";

/**
 * CloudWatch metrics. Services record what really happens (Lambda
 * invocations, API Gateway requests, load balancer requests, Auto Scaling's
 * CPU) as one-minute aggregates; statistics for any period are computed from
 * them, the way CloudWatch does. Resources that don't really run in
 * Nuvora (EC2 instances outside Auto Scaling, RDS databases) get simulated
 * metrics, and anything simulated says so.
 */

export type Statistic = "SampleCount" | "Average" | "Sum" | "Minimum" | "Maximum";
export const STATISTICS: Statistic[] = ["SampleCount", "Average", "Sum", "Minimum", "Maximum"];

export interface Dimension {
  Name: string;
  Value: string;
}

/** Canonical form for storage and comparison: sorted "Name=value|Name=value". */
export function dimKey(dims: Dimension[] | Record<string, string>): string {
  const list = Array.isArray(dims) ? dims : Object.entries(dims).map(([Name, Value]) => ({ Name, Value }));
  return list
    .map((d) => `${d.Name}=${d.Value}`)
    .sort()
    .join("|");
}

export function parseDimKey(key: string): Dimension[] {
  if (!key) return [];
  return key.split("|").map((p) => {
    const i = p.indexOf("=");
    return { Name: p.slice(0, i), Value: p.slice(i + 1) };
  });
}

export interface Datapoint {
  Timestamp: string;
  SampleCount?: number;
  Average?: number;
  Sum?: number;
  Minimum?: number;
  Maximum?: number;
  Unit: string;
}

export interface StatisticsQuery {
  namespace: string;
  name: string;
  dimensions: Dimension[];
  start: Date;
  end: Date;
  /** Seconds, a multiple of 60. */
  period: number;
  statistics: Statistic[];
}

/** A deterministic value in [0, 1) for a resource and minute: simulated metrics look the same on every read. */
function noise(seed: string, minute: number): number {
  const h = createHash("sha1").update(`${seed}:${minute}`).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

const MINUTE = 60_000;

/** Metrics Nuvora generates rather than records: resources that don't really run here. */
const SIMULATED: Record<string, { unit: string; dims: string[] }> = {
  "AWS/EC2:CPUUtilization": { unit: "Percent", dims: ["InstanceId"] },
  "AWS/RDS:CPUUtilization": { unit: "Percent", dims: ["DBInstanceIdentifier"] },
  "AWS/RDS:DatabaseConnections": { unit: "Count", dims: ["DBInstanceIdentifier"] },
  "AWS/RDS:FreeStorageSpace": { unit: "Bytes", dims: ["DBInstanceIdentifier"] },
};

export const isSimulated = (namespace: string, name: string) => `${namespace}:${name}` in SIMULATED;

export class Metrics {
  constructor(
    private engine: Engine,
    private store: ResourceStore,
    private now: () => Date,
  ) {}

  /** Records one value (never throws: metrics must not break the thing being measured). */
  async record(accountId: string, region: string, namespace: string, name: string, dims: Record<string, string>, value: number, unit: string, at = this.now()) {
    try {
      const minute = new Date(Math.floor(at.getTime() / MINUTE) * MINUTE);
      await this.store.putMetric({ accountId, region, namespace, name, dimensions: dimKey(dims) }, minute, value, unit);
    } catch (e) {
      console.error("[cloudlab] metric not recorded", namespace, name, e);
    }
  }

  /** Records the same value under several dimension sets (e.g. per function and across all functions). */
  async recordMany(accountId: string, region: string, namespace: string, name: string, dimSets: Record<string, string>[], value: number, unit: string) {
    await Promise.all(dimSets.map((d) => this.record(accountId, region, namespace, name, d, value, unit)));
  }

  /** One-minute points: recorded ones, or simulated ones for resources that don't really run. */
  async points(accountId: string, region: string, namespace: string, name: string, dims: Dimension[], from: Date, to: Date): Promise<MetricPoint[]> {
    const key = dimKey(dims);
    const recorded = await this.store.queryMetric({ accountId, region, namespace, name, dimensions: key }, from, to);
    if (!isSimulated(namespace, name)) return recorded;
    const simulated = await this.simulate(accountId, region, namespace, name, dims, from, to);
    // Recorded data wins (e.g. CPU of instances Auto Scaling looks after).
    const have = new Set(recorded.map((p) => p.minute.getTime()));
    return [...recorded, ...simulated.filter((p) => !have.has(p.minute.getTime()))].sort((a, b) => a.minute.getTime() - b.minute.getTime());
  }

  private async simulate(accountId: string, region: string, namespace: string, name: string, dims: Dimension[], from: Date, to: Date): Promise<MetricPoint[]> {
    const spec = SIMULATED[`${namespace}:${name}`];
    const d = Object.fromEntries(dims.map((x) => [x.Name, x.Value]));
    if (dims.length !== spec.dims.length || !spec.dims.every((n) => n in d)) return [];
    const list = (service: string, type: string) => this.engine.list(accountId, { service, type, region });

    let resource: Resource | undefined;
    let running: (r: Resource) => boolean;
    let value: (r: Resource, minute: number) => number;
    if (namespace === "AWS/EC2") {
      resource = (await list("compute", "instance")).find((i) => i.id === d.InstanceId);
      running = (r) => r.state === "running" || r.state === "pending" || r.state === "stopping";
      value = (r, m) => +(1.5 + 6 * noise(r.id, m)).toFixed(2);
    } else {
      resource = (await list("rds", "db-instance")).find((x) => x.name === d.DBInstanceIdentifier);
      running = (r) => r.state !== "stopped" && r.state !== "creating" && r.state !== "starting";
      if (name === "CPUUtilization") value = (r, m) => +(2 + 9 * noise(r.id, m)).toFixed(2);
      else if (name === "DatabaseConnections") value = (r, m) => Math.floor(3 * noise(`${r.id}c`, m));
      else value = (r) => Number(r.config.allocatedStorage) * 1024 ** 3 * 0.97;
    }
    if (!resource || !running(resource)) return [];
    // Data from when the resource started (approximately: its creation, or its last change of state).
    const since = Math.max(new Date(resource.createdAt).getTime(), from.getTime());
    const until = Math.min(this.now().getTime(), to.getTime());
    const out: MetricPoint[] = [];
    for (let m = Math.ceil(since / MINUTE) * MINUTE; m < until; m += MINUTE) {
      const v = value(resource, m);
      out.push({ minute: new Date(m), sum: v, count: 1, min: v, max: v, unit: spec.unit });
    }
    return out;
  }

  /** GetMetricStatistics: datapoints per period, only for periods with data. */
  async statistics(accountId: string, region: string, q: StatisticsQuery): Promise<Datapoint[]> {
    if (q.start >= q.end) throw new EngineError("InvalidParameterValue", "The parameter StartTime must be less than the parameter EndTime.");
    if (!Number.isInteger(q.period) || q.period < 60 || q.period % 60 !== 0) {
      throw new EngineError("InvalidParameterValue", "The parameter Period must be a multiple of 60.");
    }
    const count = Math.ceil((q.end.getTime() - q.start.getTime()) / (q.period * 1000));
    if (count > 1440) {
      throw new EngineError(
        "InvalidParameterCombination",
        `You have requested up to ${count.toLocaleString("en-US")} datapoints, which exceeds the limit of 1,440. You may reduce the datapoints requested by increasing Period, or decreasing the time range.`,
      );
    }
    if (q.statistics.length === 0) throw new EngineError("InvalidParameterCombination", "At least one of the parameters Statistics and ExtendedStatistics must be specified.");
    const points = await this.points(accountId, region, q.namespace, q.name, q.dimensions, q.start, q.end);
    const periodMs = q.period * 1000;
    const buckets = new Map<number, MetricPoint[]>();
    for (const p of points) {
      const b = Math.floor(p.minute.getTime() / periodMs) * periodMs;
      buckets.set(b, [...(buckets.get(b) ?? []), p]);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([b, ps]) => {
        const sum = ps.reduce((n, p) => n + p.sum, 0);
        const samples = ps.reduce((n, p) => n + p.count, 0);
        const all: Record<Statistic, number> = {
          SampleCount: samples,
          Sum: sum,
          Average: samples ? sum / samples : 0,
          Minimum: Math.min(...ps.map((p) => p.min)),
          Maximum: Math.max(...ps.map((p) => p.max)),
        };
        const dp: Datapoint = { Timestamp: new Date(b).toISOString().replace(".000Z", "Z"), Unit: ps[0].unit };
        for (const s of q.statistics) dp[s] = +all[s].toFixed(6);
        return dp;
      });
  }

  /** ListMetrics: what has data in the last two weeks, plus simulated metrics for existing resources. */
  async list(accountId: string, region: string, filter: { namespace?: string; name?: string; dimensions?: Dimension[] } = {}): Promise<MetricId[]> {
    const since = new Date(this.now().getTime() - 14 * 24 * 60 * MINUTE);
    const recorded = await this.store.listMetrics(accountId, region, since, { namespace: filter.namespace, name: filter.name });
    const simulated: MetricId[] = [];
    const want = (ns: string, n: string) => (!filter.namespace || filter.namespace === ns) && (!filter.name || filter.name === n);
    if (want("AWS/EC2", "CPUUtilization")) {
      for (const i of await this.engine.list(accountId, { service: "compute", type: "instance", region })) {
        if (i.state !== "terminated") simulated.push({ namespace: "AWS/EC2", name: "CPUUtilization", dimensions: dimKey({ InstanceId: i.id }), unit: "Percent" });
      }
    }
    for (const db of await this.engine.list(accountId, { service: "rds", type: "db-instance", region })) {
      for (const [n, unit] of [
        ["CPUUtilization", "Percent"],
        ["DatabaseConnections", "Count"],
        ["FreeStorageSpace", "Bytes"],
      ]) {
        if (want("AWS/RDS", n)) simulated.push({ namespace: "AWS/RDS", name: n, dimensions: dimKey({ DBInstanceIdentifier: db.name }), unit });
      }
    }
    const seen = new Map<string, MetricId>();
    for (const m of [...recorded, ...simulated]) seen.set(`${m.namespace}|${m.name}|${m.dimensions}`, m);
    let items = [...seen.values()];
    if (filter.dimensions?.length) {
      items = items.filter((m) => {
        const dims = parseDimKey(m.dimensions);
        return filter.dimensions!.every((f) => dims.some((d) => d.Name === f.Name && (!f.Value || d.Value === f.Value)));
      });
    }
    return items.sort((a, b) => `${a.namespace}${a.name}${a.dimensions}`.localeCompare(`${b.namespace}${b.name}${b.dimensions}`));
  }

  /** PutMetricData: your own metrics, in your own namespace. */
  async putData(
    accountId: string,
    region: string,
    namespace: string,
    items: { name: string; dimensions: Dimension[]; value: number; unit?: string; timestamp?: Date }[],
  ) {
    if (!namespace || namespace.startsWith("AWS/")) {
      throw new EngineError("InvalidParameterValue", `The value ${namespace || "(empty)"} for parameter Namespace is invalid.`);
    }
    if (items.length === 0) throw new EngineError("MissingParameter", "The parameter MetricData is required.");
    if (items.length > 1000) throw new EngineError("InvalidParameterValue", "The collection MetricData must not have a size greater than 1000.");
    const now = this.now().getTime();
    items.forEach((it, i) => {
      const n = i + 1;
      if (!Number.isFinite(it.value)) throw new EngineError("InvalidParameterValue", `The value for parameter MetricData.member.${n}.Value is invalid.`);
      if (it.dimensions.length > 30) throw new EngineError("InvalidParameterValue", `The collection MetricData.member.${n}.Dimensions must not have a size greater than 30.`);
      const t = it.timestamp?.getTime() ?? now;
      if (t > now + 2 * 60 * MINUTE) {
        throw new EngineError("InvalidParameterValue", `The parameter MetricData.member.${n}.Timestamp must specify a time no more than two hours in the future.`);
      }
      if (t < now - 14 * 24 * 60 * MINUTE) {
        throw new EngineError("InvalidParameterValue", `The parameter MetricData.member.${n}.Timestamp must specify a time within the past two weeks.`);
      }
    });
    for (const it of items) {
      await this.record(accountId, region, namespace, it.name, Object.fromEntries(it.dimensions.map((d) => [d.Name, d.Value])), it.value, it.unit ?? "None", it.timestamp ?? this.now());
    }
  }

  // ---------- what services record ----------

  async lambdaInvoked(fn: Resource, r: { durationMs: number; error: boolean; throttled?: boolean }) {
    const dims: Record<string, string>[] = [{ FunctionName: fn.name }, {}];
    const { accountId, region } = fn;
    if (r.throttled) return this.recordMany(accountId, region, "AWS/Lambda", "Throttles", dims, 1, "Count");
    await Promise.all([
      this.recordMany(accountId, region, "AWS/Lambda", "Invocations", dims, 1, "Count"),
      this.recordMany(accountId, region, "AWS/Lambda", "Errors", dims, r.error ? 1 : 0, "Count"),
      this.recordMany(accountId, region, "AWS/Lambda", "Duration", dims, r.durationMs, "Milliseconds"),
    ]);
  }

  async apiRequest(api: Resource, stage: string | null, r: { status: number; latencyMs: number; integrationMs?: number }) {
    const dims: Record<string, string>[] = [{ ApiId: api.id }, ...(stage ? [{ ApiId: api.id, Stage: stage }] : [])];
    const { accountId, region } = api;
    await Promise.all([
      this.recordMany(accountId, region, "AWS/ApiGateway", "Count", dims, 1, "Count"),
      this.recordMany(accountId, region, "AWS/ApiGateway", "4xx", dims, r.status >= 400 && r.status < 500 ? 1 : 0, "Count"),
      this.recordMany(accountId, region, "AWS/ApiGateway", "5xx", dims, r.status >= 500 ? 1 : 0, "Count"),
      this.recordMany(accountId, region, "AWS/ApiGateway", "Latency", dims, r.latencyMs, "Milliseconds"),
      ...(r.integrationMs !== undefined ? [this.recordMany(accountId, region, "AWS/ApiGateway", "IntegrationLatency", dims, r.integrationMs, "Milliseconds")] : []),
    ]);
  }

  async loadBalancerRequest(lb: Resource, r: { status: number | null; ms: number }) {
    const dims = [{ LoadBalancer: loadBalancerDimension(lb) }];
    const { accountId, region } = lb;
    const ops = [this.recordMany(accountId, region, "AWS/ApplicationELB", "RequestCount", dims, 1, "Count")];
    if (r.status !== null && r.status < 300) {
      ops.push(this.recordMany(accountId, region, "AWS/ApplicationELB", "HTTPCode_Target_2XX_Count", dims, 1, "Count"));
      ops.push(this.recordMany(accountId, region, "AWS/ApplicationELB", "TargetResponseTime", dims, r.ms / 1000, "Seconds"));
    } else if (r.status !== null && r.status >= 500) {
      ops.push(this.recordMany(accountId, region, "AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", dims, 1, "Count"));
    }
    await Promise.all(ops);
  }

  async autoScalingCpu(group: Resource, members: Resource[], averageCpu: number) {
    const running = members.filter((m) => m.state === "running");
    const { accountId, region } = group;
    await Promise.all([
      ...(running.length ? [this.record(accountId, region, "AWS/EC2", "CPUUtilization", { AutoScalingGroupName: group.name }, averageCpu, "Percent")] : []),
      ...running.map((m) => this.record(accountId, region, "AWS/EC2", "CPUUtilization", { InstanceId: m.id }, averageCpu, "Percent")),
      this.record(accountId, region, "AWS/AutoScaling", "GroupInServiceInstances", { AutoScalingGroupName: group.name }, running.length, "Count"),
    ]);
  }
}

/** ALB metrics use "app/<name>/<id>" as the LoadBalancer dimension. */
export const loadBalancerDimension = (lb: Resource) => lb.id.split(":loadbalancer/")[1] ?? lb.name;

/** Whether an instance is looked after by Auto Scaling (its CPU is recorded, not simulated). */
export const isManagedInstance = (i: Resource) => !!systemOf(i).managedBy;
