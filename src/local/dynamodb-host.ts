import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_REGION } from "@/engine/catalog";
import type { TableHost } from "@/engine/dynamodb/host";
import { tableNotFound } from "@/engine/services/dynamodb";
import type { Resource } from "@/engine/types";

/** What the agent is told about a table (by CloudLab, or by the CreateTable it sent there). */
export interface TableSpec {
  /** The table's ARN. */
  id: string;
  name: string;
  config: Record<string, unknown>;
  createdAt?: string;
}

/** What CloudLab shows about a table on this computer: counts, never the items themselves. */
export interface TableReport {
  itemCount: number;
  tableSizeBytes: number;
  stats: unknown;
  throttledAt?: unknown;
}

const FILE = /^[a-zA-Z0-9_.-]{3,255}\.json$/;

/**
 * DynamoDB tables on the learner's computer: one JSON file per table, holding
 * its settings and items. The agent runs CloudLab's own DynamoDB code against
 * this (as a TableHost), so local tables follow the same rules as any other.
 */
export class FileTableHost implements TableHost {
  readonly holdsLocalItems = true;
  private tables = new Map<string, Resource>();
  private calls = new Map<string, number[]>();
  readonly metrics = { record: async () => undefined };

  constructor(
    private dir: string,
    private onChange: (t: Resource) => void = () => undefined,
    readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!FILE.test(f)) continue;
      try {
        const t = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Resource;
        if (t?.name && t.config) this.tables.set(t.name, t);
      } catch {
        // A damaged file is left alone (and skipped) rather than lost.
      }
    }
  }

  private file(name: string) {
    return path.join(this.dir, `${name}.json`);
  }

  private save(t: Resource) {
    const tmp = `${this.file(t.name)}.tmp`;
    writeFileSync(tmp, JSON.stringify(t));
    renameSync(tmp, this.file(t.name));
  }

  /** Creates the table, or brings its settings up to date. Items are kept. */
  upsert(spec: TableSpec): Resource {
    const old = this.tables.get(spec.name);
    const now = this.now().toISOString();
    const t: Resource = {
      id: spec.id,
      accountId: "local",
      region: LOCAL_REGION,
      service: "dynamodb",
      type: "table",
      name: spec.name,
      state: "ACTIVE",
      pendingState: null,
      transitionAt: null,
      config: { ...spec.config, name: spec.name },
      attributes: { items: {}, itemCount: 0, tableSizeBytes: 0, ...(old?.attributes ?? {}), arn: spec.id },
      refs: [],
      createdAt: old?.createdAt ?? spec.createdAt ?? now,
      updatedAt: now,
    };
    this.tables.set(t.name, t);
    this.save(t);
    return t;
  }

  remove(name: string) {
    this.tables.delete(name);
    rmSync(this.file(name), { force: true });
  }

  has(name: string) {
    return this.tables.has(name);
  }

  names() {
    return [...this.tables.keys()];
  }

  byName(name: string): Resource {
    const t = this.tables.get(name);
    if (!t) throw tableNotFound(name);
    return structuredClone(t);
  }

  report(name: string): TableReport | null {
    const t = this.tables.get(name);
    if (!t) return null;
    const a = t.attributes;
    return { itemCount: Number(a.itemCount ?? 0), tableSizeBytes: Number(a.tableSizeBytes ?? 0), stats: a.stats ?? {}, ...(a.throttledAt ? { throttledAt: a.throttledAt } : {}) };
  }

  /** Where a table's file is (shown in the console). */
  pathOf(name: string) {
    return this.file(name);
  }

  // ---------- TableHost ----------

  async get(_accountId: string, id: string): Promise<Resource> {
    const t = [...this.tables.values()].find((x) => x.id === id || x.name === id);
    if (!t) throw tableNotFound(id.split("/").pop() ?? id);
    return structuredClone(t);
  }

  async list(_accountId: string, filter: { service?: string; type?: string; region?: string }): Promise<Resource[]> {
    if ((filter.service && filter.service !== "dynamodb") || (filter.type && filter.type !== "table")) return [];
    if (filter.region && filter.region !== LOCAL_REGION) return [];
    return [...this.tables.values()].map((t) => structuredClone(t));
  }

  async setAttributes(_accountId: string, id: string, patch: Record<string, unknown>): Promise<void> {
    const t = [...this.tables.values()].find((x) => x.id === id);
    if (!t) return;
    t.attributes = { ...t.attributes, ...patch };
    t.updatedAt = this.now().toISOString();
    this.save(t);
    this.onChange(t);
  }

  async countInWindow(key: string, windowMs: number): Promise<number> {
    const now = this.now().getTime();
    const recent = (this.calls.get(key) ?? []).filter((at) => at > now - windowMs);
    recent.push(now);
    this.calls.set(key, recent);
    return recent.length;
  }
}
