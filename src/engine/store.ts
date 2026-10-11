import type { Resource } from "./types";
import {
  MAX_EVENTS_PER_GROUP,
  METRIC_RETENTION_MS,
  type LogEvent,
  type LogQuery,
  type LogStreamInfo,
  type MetricId,
  type MetricKey,
  type MetricPoint,
} from "./telemetry/types";

export interface ListFilter {
  service?: string;
  type?: string;
  region?: string;
}

/** Persistence used by the engine. Postgres in production, memory in tests and local fallback. */
export interface ResourceStore {
  get(accountId: string, id: string): Promise<Resource | null>;
  /** Looks up an ID across all accounts (for globally unique names such as buckets). */
  getAny(id: string): Promise<Resource | null>;
  list(accountId: string, filter?: ListFilter): Promise<Resource[]>;
  /** Resources of the account that reference `id`. */
  findReferencing(accountId: string, id: string): Promise<Resource[]>;
  insert(resource: Resource): Promise<void>;
  update(resource: Resource): Promise<void>;
  delete(accountId: string, id: string): Promise<void>;
  /** Deletes every resource the account has in a region (used by "Reset my lab"). */
  deleteRegion(accountId: string, region: string): Promise<number>;
  /** Claims a one-off key; true only for the first caller. Guards one-time setup such as default VPCs. */
  tryClaim(key: string): Promise<boolean>;
  releaseClaim(key: string): Promise<void>;
  /** Adds one to a short-lived counter and returns the new count (rate limits). */
  increment(key: string, ttlMs: number, now: Date): Promise<number>;
  /**
   * Moves every resource and claim from one account to another, but only if the
   * target account has nothing yet. Returns how many resources moved.
   */
  transferAccount(from: string, to: string): Promise<number>;

  /** Adds a value to a metric's one-minute aggregate (CloudWatch metrics). */
  putMetric(key: MetricKey, minute: Date, value: number, unit: string): Promise<void>;
  /** A metric's one-minute aggregates in [from, to). */
  queryMetric(key: MetricKey, from: Date, to: Date): Promise<MetricPoint[]>;
  /** Metrics with data since `since`, optionally narrowed. */
  listMetrics(accountId: string, region: string, since: Date, filter?: { namespace?: string; name?: string }): Promise<MetricId[]>;

  /** CloudWatch Logs. */
  putLogEvents(accountId: string, region: string, group: string, stream: string, events: { timestamp: number; message: string }[]): Promise<void>;
  queryLogEvents(q: LogQuery): Promise<LogEvent[]>;
  logStreams(accountId: string, region: string, group: string): Promise<LogStreamInfo[]>;
  /** Deletes a group's events (all, or older than `before`). */
  deleteLogEvents(accountId: string, region: string, group: string, before?: number): Promise<void>;

  /** File contents for storage objects (base64), keyed by the object's resource ID. */
  putBlob(accountId: string, id: string, data: string): Promise<void>;
  getBlob(accountId: string, id: string): Promise<string | null>;
  deleteBlob(accountId: string, id: string): Promise<void>;
}

export class MemoryStore implements ResourceStore {
  private items = new Map<string, Resource>();
  private claims = new Set<string>();
  private blobs = new Map<string, { accountId: string; data: string }>();
  private metrics = new Map<string, MetricPoint & { key: MetricKey }>();
  private logs: (LogEvent & { accountId: string; region: string; group: string })[] = [];
  private logSeq = 0;

  async putMetric(key: MetricKey, minute: Date, value: number, unit: string) {
    const k = `${key.accountId}|${key.region}|${key.namespace}|${key.name}|${key.dimensions}|${minute.getTime()}`;
    const p = this.metrics.get(k);
    if (p) {
      p.sum += value;
      p.count += 1;
      p.min = Math.min(p.min, value);
      p.max = Math.max(p.max, value);
    } else this.metrics.set(k, { key, minute, sum: value, count: 1, min: value, max: value, unit });
    if (this.metrics.size % 500 === 0) {
      const cutoff = minute.getTime() - METRIC_RETENTION_MS;
      for (const [id, v] of this.metrics) if (v.minute.getTime() < cutoff) this.metrics.delete(id);
    }
  }

  async queryMetric(key: MetricKey, from: Date, to: Date) {
    const out: MetricPoint[] = [];
    for (const p of this.metrics.values()) {
      const k = p.key;
      if (k.accountId !== key.accountId || k.region !== key.region || k.namespace !== key.namespace || k.name !== key.name || k.dimensions !== key.dimensions) continue;
      if (p.minute >= from && p.minute < to) out.push({ minute: p.minute, sum: p.sum, count: p.count, min: p.min, max: p.max, unit: p.unit });
    }
    return out.sort((a, b) => a.minute.getTime() - b.minute.getTime());
  }

  async listMetrics(accountId: string, region: string, since: Date, filter: { namespace?: string; name?: string } = {}) {
    const seen = new Map<string, MetricId>();
    for (const p of this.metrics.values()) {
      const k = p.key;
      if (k.accountId !== accountId || k.region !== region || p.minute < since) continue;
      if (filter.namespace && k.namespace !== filter.namespace) continue;
      if (filter.name && k.name !== filter.name) continue;
      seen.set(`${k.namespace}|${k.name}|${k.dimensions}`, { namespace: k.namespace, name: k.name, dimensions: k.dimensions, unit: p.unit });
    }
    return [...seen.values()];
  }

  async putLogEvents(accountId: string, region: string, group: string, stream: string, events: { timestamp: number; message: string }[]) {
    const now = Date.now();
    for (const e of events) this.logs.push({ id: ++this.logSeq, accountId, region, group, stream, timestamp: e.timestamp, ingestedAt: now, message: e.message });
    const mine = this.logs.filter((l) => l.accountId === accountId && l.region === region && l.group === group);
    if (mine.length > MAX_EVENTS_PER_GROUP) {
      const drop = new Set(mine.sort((a, b) => a.id - b.id).slice(0, mine.length - MAX_EVENTS_PER_GROUP).map((l) => l.id));
      this.logs = this.logs.filter((l) => !drop.has(l.id));
    }
  }

  async queryLogEvents(q: LogQuery) {
    const items = this.logs.filter(
      (l) =>
        l.accountId === q.accountId &&
        l.region === q.region &&
        l.group === q.group &&
        (!q.streams?.length || q.streams.includes(l.stream)) &&
        (q.from === undefined || l.timestamp >= q.from) &&
        (q.to === undefined || l.timestamp < q.to) &&
        (q.afterId === undefined || (q.ascending ? l.id > q.afterId : l.id < q.afterId)),
    );
    items.sort((a, b) => (q.ascending ? a.timestamp - b.timestamp || a.id - b.id : b.timestamp - a.timestamp || b.id - a.id));
    return items.slice(0, q.limit).map(({ id, stream, timestamp, ingestedAt, message }) => ({ id, stream, timestamp, ingestedAt, message }));
  }

  async logStreams(accountId: string, region: string, group: string) {
    const by = new Map<string, LogStreamInfo>();
    for (const l of this.logs) {
      if (l.accountId !== accountId || l.region !== region || l.group !== group) continue;
      const s = by.get(l.stream) ?? { stream: l.stream, firstEventTimestamp: l.timestamp, lastEventTimestamp: l.timestamp, lastIngestionTime: l.ingestedAt, storedBytes: 0 };
      s.firstEventTimestamp = Math.min(s.firstEventTimestamp, l.timestamp);
      s.lastEventTimestamp = Math.max(s.lastEventTimestamp, l.timestamp);
      s.lastIngestionTime = Math.max(s.lastIngestionTime, l.ingestedAt);
      s.storedBytes += l.message.length;
      by.set(l.stream, s);
    }
    return [...by.values()].sort((a, b) => b.lastEventTimestamp - a.lastEventTimestamp);
  }

  async deleteLogEvents(accountId: string, region: string, group: string, before?: number) {
    this.logs = this.logs.filter((l) => !(l.accountId === accountId && l.region === region && l.group === group && (before === undefined || l.timestamp < before)));
  }

  async putBlob(accountId: string, id: string, data: string) {
    this.blobs.set(id, { accountId, data });
  }

  async getBlob(accountId: string, id: string) {
    const b = this.blobs.get(id);
    return b && b.accountId === accountId ? b.data : null;
  }

  async deleteBlob(accountId: string, id: string) {
    if (this.blobs.get(id)?.accountId === accountId) this.blobs.delete(id);
  }

  async deleteRegion(accountId: string, region: string) {
    let n = 0;
    for (const [id, r] of this.items) {
      if (r.accountId === accountId && r.region === region) {
        this.items.delete(id);
        this.blobs.delete(id);
        n++;
      }
    }
    for (const [k, m] of this.metrics) if (m.key.accountId === accountId && m.key.region === region) this.metrics.delete(k);
    this.logs = this.logs.filter((l) => !(l.accountId === accountId && l.region === region));
    return n;
  }

  async tryClaim(key: string) {
    if (this.claims.has(key)) return false;
    this.claims.add(key);
    return true;
  }

  async releaseClaim(key: string) {
    this.claims.delete(key);
  }

  private counters = new Map<string, { count: number; expiresAt: number }>();

  async increment(key: string, ttlMs: number, now: Date) {
    const t = now.getTime();
    for (const [k, v] of this.counters) if (v.expiresAt < t) this.counters.delete(k);
    const c = this.counters.get(key) ?? { count: 0, expiresAt: t + ttlMs };
    c.count++;
    this.counters.set(key, c);
    return c.count;
  }

  async transferAccount(from: string, to: string) {
    if ([...this.items.values()].some((r) => r.accountId === to)) return 0;
    let n = 0;
    for (const r of this.items.values()) {
      if (r.accountId === from) {
        r.accountId = to;
        n++;
      }
    }
    for (const b of this.blobs.values()) if (b.accountId === from) b.accountId = to;
    for (const m of this.metrics.values()) if (m.key.accountId === from) m.key = { ...m.key, accountId: to };
    for (const l of this.logs) if (l.accountId === from) l.accountId = to;
    for (const key of [...this.claims]) {
      if (key.includes(`:${from}:`)) {
        this.claims.delete(key);
        this.claims.add(key.replace(`:${from}:`, `:${to}:`));
      }
    }
    return n;
  }

  async get(accountId: string, id: string) {
    const r = this.items.get(id);
    return r && r.accountId === accountId ? structuredClone(r) : null;
  }

  async getAny(id: string) {
    const r = this.items.get(id);
    return r ? structuredClone(r) : null;
  }

  async list(accountId: string, filter: ListFilter = {}) {
    return [...this.items.values()]
      .filter(
        (r) =>
          r.accountId === accountId &&
          (!filter.service || r.service === filter.service) &&
          (!filter.type || r.type === filter.type) &&
          (!filter.region || r.region === filter.region),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => structuredClone(r));
  }

  async findReferencing(accountId: string, id: string) {
    return [...this.items.values()]
      .filter((r) => r.accountId === accountId && r.refs.includes(id))
      .map((r) => structuredClone(r));
  }

  async insert(resource: Resource) {
    if (this.items.has(resource.id)) throw new Error(`Duplicate id ${resource.id}`);
    this.items.set(resource.id, structuredClone(resource));
  }

  async update(resource: Resource) {
    this.items.set(resource.id, structuredClone(resource));
  }

  async delete(accountId: string, id: string) {
    const r = this.items.get(id);
    if (r && r.accountId === accountId) this.items.delete(id);
  }
}
