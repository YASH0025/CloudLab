import { and, arrayContains, desc, eq, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { MemoryStore, type ListFilter, type ResourceStore } from "@/engine/store";
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

export class PostgresStore implements ResourceStore {
  private db;

  constructor(url: string) {
    this.db = drizzle({ client: neon(url) });
  }

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
}

const globalForStore = globalThis as unknown as { __cloudlabStore?: ResourceStore };

/**
 * Postgres (Neon) when DATABASE_URL is set. Without it, an in-memory store is
 * used so the app runs straight after cloning; its data resets on restart and
 * it is not suitable for deployment.
 */
export function getStore(): ResourceStore {
  if (globalForStore.__cloudlabStore) return globalForStore.__cloudlabStore;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn("[cloudlab] DATABASE_URL is not set; using an in-memory store (data resets on restart).");
  }
  globalForStore.__cloudlabStore = url ? new PostgresStore(url) : new MemoryStore();
  return globalForStore.__cloudlabStore;
}
