import { and, arrayContains, asc, desc, eq, gt, gte, inArray, like, lt, sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { ListFilter, ResourceStore } from "@/engine/store";
import type { Resource } from "@/engine/types";
import { blobs, claims, counters, logEvents, metricData, resources, type ResourceRow } from "./schema";
import {
  MAX_EVENTS_PER_GROUP,
  METRIC_RETENTION_MS,
  type LogEvent,
  type LogQuery,
  type LogStreamInfo,
  type MetricId,
  type MetricKey,
  type MetricPoint,
} from "@/engine/telemetry/types";

function toResource(row: ResourceRow): Resource {
  return {
    id: row.id,
    accountId: row.accountId,
    region: row.region,
    service: row.service,
    type: row.type,
    name: row.name,
    state: row.state,
    pendingState: row.pendingState,
    transitionAt: row.transitionAt ? row.transitionAt.toISOString() : null,
    config: row.config,
    attributes: row.attributes,
    refs: row.refs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRow(r: Resource): ResourceRow {
  return {
    id: r.id,
    accountId: r.accountId,
    region: r.region,
    service: r.service,
    type: r.type,
    name: r.name,
    state: r.state,
    pendingState: r.pendingState,
    transitionAt: r.transitionAt ? new Date(r.transitionAt) : null,
    config: r.config,
    attributes: r.attributes,
    refs: r.refs,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
}

/**
 * The Postgres-backed store. It takes any Drizzle Postgres database, so the same
 * code runs on Neon in production and on PGlite (in-process Postgres) in tests.
 */
export class PostgresStore implements ResourceStore {
  // Any Drizzle Postgres driver (neon-http, pglite, node-postgres...).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private db: PgDatabase<any, any, any>) {}

  async get(accountId: string, id: string) {
    const rows = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.accountId, accountId), eq(resources.id, id)))
      .limit(1);
    return rows[0] ? toResource(rows[0]) : null;
  }

  async getAny(id: string) {
    const rows = await this.db.select().from(resources).where(eq(resources.id, id)).limit(1);
    return rows[0] ? toResource(rows[0]) : null;
  }

  async list(accountId: string, filter: ListFilter = {}) {
    const conditions: SQL[] = [eq(resources.accountId, accountId)];
    if (filter.service) conditions.push(eq(resources.service, filter.service));
    if (filter.type) conditions.push(eq(resources.type, filter.type));
    if (filter.region) conditions.push(eq(resources.region, filter.region));
    const rows = await this.db
      .select()
      .from(resources)
      .where(and(...conditions))
      .orderBy(desc(resources.createdAt));
    return rows.map(toResource);
  }

  async findReferencing(accountId: string, id: string) {
    const rows = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.accountId, accountId), arrayContains(resources.refs, [id])));
    return rows.map(toResource);
  }

  async insert(resource: Resource) {
    await this.db.insert(resources).values(toRow(resource));
  }

  async update(resource: Resource) {
    const { id, accountId, ...rest } = toRow(resource);
    await this.db
      .update(resources)
      .set(rest)
      .where(and(eq(resources.accountId, accountId), eq(resources.id, id)));
  }

  async delete(accountId: string, id: string) {
    await this.db.delete(resources).where(and(eq(resources.accountId, accountId), eq(resources.id, id)));
  }

  async deleteRegion(accountId: string, region: string) {
    const rows = await this.db
      .delete(resources)
      .where(and(eq(resources.accountId, accountId), eq(resources.region, region)))
      .returning({ id: resources.id });
    await this.db.delete(metricData).where(and(eq(metricData.accountId, accountId), eq(metricData.region, region)));
    await this.db.delete(logEvents).where(and(eq(logEvents.accountId, accountId), eq(logEvents.region, region)));
    // File contents of objects that no longer exist.
    await this.db
      .delete(blobs)
      .where(
        and(eq(blobs.accountId, accountId), sql`${blobs.id} not in (select ${resources.id} from ${resources} where ${resources.accountId} = ${accountId})`),
      );
    return rows.length;
  }

  async putBlob(accountId: string, id: string, data: string) {
    await this.db
      .insert(blobs)
      .values({ id, accountId, data })
      .onConflictDoUpdate({ target: blobs.id, set: { data, accountId }, setWhere: eq(blobs.accountId, accountId) });
  }

  async getBlob(accountId: string, id: string) {
    const rows = await this.db
      .select({ data: blobs.data })
      .from(blobs)
      .where(and(eq(blobs.accountId, accountId), eq(blobs.id, id)))
      .limit(1);
    return rows[0]?.data ?? null;
  }

  async deleteBlob(accountId: string, id: string) {
    await this.db.delete(blobs).where(and(eq(blobs.accountId, accountId), eq(blobs.id, id)));
  }

  async tryClaim(key: string) {
    const rows = await this.db.insert(claims).values({ key }).onConflictDoNothing().returning({ key: claims.key });
    return rows.length > 0;
  }

  async releaseClaim(key: string) {
    await this.db.delete(claims).where(eq(claims.key, key));
  }

  // ---------- CloudWatch metrics ----------

  async putMetric(key: MetricKey, minute: Date, value: number, unit: string) {
    if (Math.random() < 0.005) await this.db.delete(metricData).where(lt(metricData.minute, new Date(minute.getTime() - METRIC_RETENTION_MS)));
    await this.db
      .insert(metricData)
      .values({ accountId: key.accountId, region: key.region, namespace: key.namespace, metricName: key.name, dimensions: key.dimensions, minute, sum: value, count: 1, min: value, max: value, unit })
      .onConflictDoUpdate({
        target: [metricData.accountId, metricData.region, metricData.namespace, metricData.metricName, metricData.dimensions, metricData.minute],
        set: {
          sum: sql`${metricData.sum} + ${value}`,
          count: sql`${metricData.count} + 1`,
          min: sql`least(${metricData.min}, ${value})`,
          max: sql`greatest(${metricData.max}, ${value})`,
        },
      });
  }

  async queryMetric(key: MetricKey, from: Date, to: Date): Promise<MetricPoint[]> {
    const rows = await this.db
      .select()
      .from(metricData)
      .where(
        and(
          eq(metricData.accountId, key.accountId),
          eq(metricData.region, key.region),
          eq(metricData.namespace, key.namespace),
          eq(metricData.metricName, key.name),
          eq(metricData.dimensions, key.dimensions),
          gte(metricData.minute, from),
          lt(metricData.minute, to),
        ),
      )
      .orderBy(asc(metricData.minute));
    return rows.map((r) => ({ minute: r.minute, sum: r.sum, count: r.count, min: r.min, max: r.max, unit: r.unit }));
  }

  async listMetrics(accountId: string, region: string, since: Date, filter: { namespace?: string; name?: string } = {}): Promise<MetricId[]> {
    const rows = await this.db
      .selectDistinct({ namespace: metricData.namespace, name: metricData.metricName, dimensions: metricData.dimensions, unit: metricData.unit })
      .from(metricData)
      .where(
        and(
          eq(metricData.accountId, accountId),
          eq(metricData.region, region),
          gte(metricData.minute, since),
          filter.namespace ? eq(metricData.namespace, filter.namespace) : undefined,
          filter.name ? eq(metricData.metricName, filter.name) : undefined,
        ),
      );
    return rows;
  }

  // ---------- CloudWatch Logs ----------

  async putLogEvents(accountId: string, region: string, group: string, stream: string, events: { timestamp: number; message: string }[]) {
    if (events.length === 0) return;
    await this.db.insert(logEvents).values(events.map((e) => ({ accountId, region, logGroup: group, logStream: stream, timestamp: new Date(e.timestamp), message: e.message })));
    // Keep each group to its newest events.
    if (Math.random() < 0.1) {
      await this.db.execute(sql`
        delete from ${logEvents}
        where ${logEvents.accountId} = ${accountId} and ${logEvents.region} = ${region} and ${logEvents.logGroup} = ${group}
          and ${logEvents.id} < (
            select ${logEvents.id} from ${logEvents}
            where ${logEvents.accountId} = ${accountId} and ${logEvents.region} = ${region} and ${logEvents.logGroup} = ${group}
            order by ${logEvents.id} desc offset ${MAX_EVENTS_PER_GROUP - 1} limit 1
          )`);
    }
  }

  async queryLogEvents(q: LogQuery): Promise<LogEvent[]> {
    const rows = await this.db
      .select()
      .from(logEvents)
      .where(
        and(
          eq(logEvents.accountId, q.accountId),
          eq(logEvents.region, q.region),
          eq(logEvents.logGroup, q.group),
          q.streams?.length ? inArray(logEvents.logStream, q.streams) : undefined,
          q.from !== undefined ? gte(logEvents.timestamp, new Date(q.from)) : undefined,
          q.to !== undefined ? lt(logEvents.timestamp, new Date(q.to)) : undefined,
          q.afterId !== undefined ? (q.ascending ? gt(logEvents.id, q.afterId) : lt(logEvents.id, q.afterId)) : undefined,
        ),
      )
      .orderBy(...(q.ascending ? [asc(logEvents.timestamp), asc(logEvents.id)] : [desc(logEvents.timestamp), desc(logEvents.id)]))
      .limit(q.limit);
    return rows.map((r) => ({ id: r.id, stream: r.logStream, timestamp: r.timestamp.getTime(), ingestedAt: r.ingestedAt.getTime(), message: r.message }));
  }

  async logStreams(accountId: string, region: string, group: string): Promise<LogStreamInfo[]> {
    const rows = await this.db
      .select({
        stream: logEvents.logStream,
        first: sql<Date>`min(${logEvents.timestamp})`,
        last: sql<Date>`max(${logEvents.timestamp})`,
        ingested: sql<Date>`max(${logEvents.ingestedAt})`,
        bytes: sql<number>`sum(length(${logEvents.message}))`,
      })
      .from(logEvents)
      .where(and(eq(logEvents.accountId, accountId), eq(logEvents.region, region), eq(logEvents.logGroup, group)))
      .groupBy(logEvents.logStream);
    const ms = (v: Date | string) => new Date(v).getTime();
    return rows
      .map((r) => ({ stream: r.stream, firstEventTimestamp: ms(r.first), lastEventTimestamp: ms(r.last), lastIngestionTime: ms(r.ingested), storedBytes: Number(r.bytes) }))
      .sort((a, b) => b.lastEventTimestamp - a.lastEventTimestamp);
  }

  async deleteLogEvents(accountId: string, region: string, group: string, before?: number) {
    await this.db
      .delete(logEvents)
      .where(
        and(
          eq(logEvents.accountId, accountId),
          eq(logEvents.region, region),
          eq(logEvents.logGroup, group),
          before !== undefined ? lt(logEvents.timestamp, new Date(before)) : undefined,
        ),
      );
  }

  async increment(key: string, ttlMs: number, now: Date) {
    // Now and then, clear out windows that have passed.
    if (Math.random() < 0.02) await this.db.delete(counters).where(lt(counters.expiresAt, now));
    const rows = await this.db
      .insert(counters)
      .values({ key, count: 1, expiresAt: new Date(now.getTime() + ttlMs) })
      .onConflictDoUpdate({ target: counters.key, set: { count: sql`${counters.count} + 1` } })
      .returning({ count: counters.count });
    return rows[0]?.count ?? 1;
  }

  async transferAccount(from: string, to: string) {
    // Only move into an empty account, so a returning user's saved lab is never overwritten.
    const existing = await this.db.select({ id: resources.id }).from(resources).where(eq(resources.accountId, to)).limit(1);
    if (existing.length > 0) return 0;
    const moved = await this.db
      .update(resources)
      .set({ accountId: to })
      .where(eq(resources.accountId, from))
      .returning({ id: resources.id });
    await this.db.update(blobs).set({ accountId: to }).where(eq(blobs.accountId, from));
    await this.db.update(metricData).set({ accountId: to }).where(eq(metricData.accountId, from));
    await this.db.update(logEvents).set({ accountId: to }).where(eq(logEvents.accountId, from));
    // Claim keys look like "default-vpc:<account>:<region>".
    const pattern = `%:${from}:%`;
    const old = await this.db.select({ key: claims.key }).from(claims).where(like(claims.key, pattern));
    if (old.length > 0) {
      await this.db
        .insert(claims)
        .values(old.map((c) => ({ key: c.key.replace(`:${from}:`, `:${to}:`) })))
        .onConflictDoNothing();
      await this.db.delete(claims).where(like(claims.key, pattern));
    }
    return moved.length;
  }
}

