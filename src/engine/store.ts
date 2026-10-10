import type { Resource } from "./types";

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
  /**
   * Moves every resource and claim from one account to another, but only if the
   * target account has nothing yet. Returns how many resources moved.
   */
  transferAccount(from: string, to: string): Promise<number>;
}

export class MemoryStore implements ResourceStore {
  private items = new Map<string, Resource>();
  private claims = new Set<string>();

  async deleteRegion(accountId: string, region: string) {
    let n = 0;
    for (const [id, r] of this.items) {
      if (r.accountId === accountId && r.region === region) {
        this.items.delete(id);
        n++;
      }
    }
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

  async transferAccount(from: string, to: string) {
    if ([...this.items.values()].some((r) => r.accountId === to)) return 0;
    let n = 0;
    for (const r of this.items.values()) {
      if (r.accountId === from) {
        r.accountId = to;
        n++;
      }
    }
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
