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

  /** File contents for storage objects (base64), keyed by the object's resource ID. */
  putBlob(accountId: string, id: string, data: string): Promise<void>;
  getBlob(accountId: string, id: string): Promise<string | null>;
  deleteBlob(accountId: string, id: string): Promise<void>;
}

export class MemoryStore implements ResourceStore {
  private items = new Map<string, Resource>();
  private claims = new Set<string>();
  private blobs = new Map<string, { accountId: string; data: string }>();

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
    for (const b of this.blobs.values()) if (b.accountId === from) b.accountId = to;
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
