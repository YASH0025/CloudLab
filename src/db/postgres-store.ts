import { and, arrayContains, desc, eq, like, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { ListFilter, ResourceStore } from "@/engine/store";
import type { Resource } from "@/engine/types";
import { claims, resources, type ResourceRow } from "./schema";

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
    return rows.length;
  }

  async tryClaim(key: string) {
    const rows = await this.db.insert(claims).values({ key }).onConflictDoNothing().returning({ key: claims.key });
    return rows.length > 0;
  }

  async releaseClaim(key: string) {
    await this.db.delete(claims).where(eq(claims.key, key));
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

