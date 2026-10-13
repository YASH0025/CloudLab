import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_REGION } from "@/engine/catalog";
import { EngineError } from "@/engine/errors";
import type { ServiceHost } from "@/engine/host";
import type { Resource } from "@/engine/types";

/** What the agent is told about a resource (by CloudLab, or by the create call it sent there). */
export interface ResourceSpec {
  /** The resource's ID in CloudLab (a table's ARN, a queue's URL). */
  id: string;
  name: string;
  config: Record<string, unknown>;
  createdAt?: string;
  /** Its state in CloudLab, for types that have one (a subscription's confirmation). */
  state?: string | null;
  /** What a new resource starts with (a subscription's token and inbox). */
  attributes?: Record<string, unknown>;
}

/** How long changes may wait in memory before they're written to disk. */
export const FLUSH_MS = 200;

const FILE = /^[a-zA-Z0-9_.~-]{1,255}\.json$/;
const SAFE = /^[a-zA-Z0-9_.-]{1,200}$/;

/**
 * A resource's file name. Table and queue names are already safe; others (an SNS
 * subscription is named "http: http://…") are encoded, since "/" and ":" can't be
 * in file names (":" not at all on Windows).
 */
const fileName = (name: string) => (SAFE.test(name) && !name.startsWith(".") ? name : `~${Buffer.from(name).toString("base64url")}`);

/**
 * One service's resources on the learner's computer (DynamoDB tables, SQS queues…):
 * one JSON file each, with the resource's settings and its data. CloudLab's own
 * service code runs against this as a ServiceHost.
 *
 * Speed: resources live in memory. A change marks its resource dirty and is written
 * within FLUSH_MS, so a burst of writes (a loop of PutItem or SendMessage) costs one
 * file write, not one per call. flush() writes everything now (the agent calls it
 * when it stops). Reads hand out copies, so a call that fails half-way (a limit
 * checked after a change) leaves nothing behind.
 */
export class FileResourceHost implements ServiceHost {
  readonly holdsLocalItems = true;
  readonly metrics = { record: async () => undefined };
  private resources = new Map<string, Resource>();
  private byId = new Map<string, Resource>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private calls = new Map<string, number[]>();

  constructor(
    protected dir: string,
    readonly service: string,
    readonly type: string,
    private notFound: (name: string) => EngineError,
    private onChange: (r: Resource) => void = () => undefined,
    readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!FILE.test(f)) continue;
      try {
        const r = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Resource;
        if (r?.name && r.config) this.index(r);
      } catch {
        // A damaged file is left alone (and skipped) rather than lost.
      }
    }
  }

  private index(r: Resource) {
    const old = this.resources.get(r.name);
    if (old) this.byId.delete(old.id);
    this.resources.set(r.name, r);
    this.byId.set(r.id, r);
  }

  private file(name: string) {
    return path.join(this.dir, `${fileName(name)}.json`);
  }

  private write(name: string) {
    const r = this.resources.get(name);
    if (!r) return;
    const tmp = `${this.file(name)}.tmp`;
    writeFileSync(tmp, JSON.stringify(r));
    renameSync(tmp, this.file(name));
  }

  private markDirty(name: string) {
    this.dirty.add(name);
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Writes every pending change to disk now. */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const name of this.dirty) this.write(name);
    this.dirty.clear();
  }

  /**
   * A copy of a resource for a caller that may change it. Services override this to
   * copy only what their code changes (DynamoDB replaces items but never edits one;
   * SQS edits its messages), which is much faster than copying everything.
   */
  protected copy(r: Resource): Resource {
    return structuredClone(r);
  }

  /** The data a new resource of this kind starts with (no items, no messages…). */
  protected initialAttributes(): Record<string, unknown> {
    return {};
  }

  /** Attributes that always follow the spec (an ARN, a URL), even for a resource that already exists. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected specAttributes(spec: ResourceSpec): Record<string, unknown> {
    return {};
  }

  /** Creates the resource, or brings its settings up to date. Its data is kept. */
  upsert(spec: ResourceSpec): Resource {
    const old = this.resources.get(spec.name);
    const now = this.now().toISOString();
    const r: Resource = {
      id: spec.id,
      accountId: "local",
      region: LOCAL_REGION,
      service: this.service,
      type: this.type,
      name: spec.name,
      state: spec.state ?? old?.state ?? "ACTIVE",
      pendingState: null,
      transitionAt: null,
      config: { ...spec.config, name: spec.name },
      attributes: { ...this.initialAttributes(), ...(old ? old.attributes : (spec.attributes ?? {})), ...this.specAttributes(spec) },
      refs: [],
      createdAt: old?.createdAt ?? spec.createdAt ?? now,
      updatedAt: now,
    };
    this.index(r);
    // Settings are rare and matter: written straight away.
    this.write(r.name);
    return this.copy(r);
  }

  remove(name: string) {
    const r = this.resources.get(name);
    if (r) this.byId.delete(r.id);
    this.resources.delete(name);
    this.dirty.delete(name);
    rmSync(this.file(name), { force: true });
  }

  has(name: string) {
    return this.resources.has(name);
  }

  /** Whether a resource (by ID or name) is in this store. */
  owns(id: string) {
    return this.byId.has(id) || this.resources.has(id);
  }

  names() {
    return [...this.resources.keys()];
  }

  /** A copy of the resource, by name. */
  byName(name: string): Resource {
    const r = this.resources.get(name);
    if (!r) throw this.notFound(name);
    return this.copy(r);
  }

  /** The live resource, for reading counts without copying (don't change it). */
  peek(name: string): Resource | undefined {
    return this.resources.get(name);
  }

  /** Where a resource's file is (shown in the console). */
  pathOf(name: string) {
    return this.file(name);
  }

  // ---------- ServiceHost ----------

  async get(_accountId: string, id: string): Promise<Resource> {
    const r = this.byId.get(id) ?? this.resources.get(id);
    if (!r) throw this.notFound(id.split(/[/:]/).pop() ?? id);
    return this.copy(r);
  }

  async list(_accountId: string, filter: { service?: string; type?: string; region?: string }): Promise<Resource[]> {
    if ((filter.service && filter.service !== this.service) || (filter.type && filter.type !== this.type)) return [];
    if (filter.region && filter.region !== LOCAL_REGION) return [];
    return [...this.resources.values()].map((r) => this.copy(r));
  }

  async setAttributes(_accountId: string, id: string, patch: Record<string, unknown>): Promise<void> {
    const r = this.byId.get(id);
    if (!r) return;
    r.attributes = { ...r.attributes, ...patch };
    r.updatedAt = this.now().toISOString();
    this.markDirty(r.name);
    this.onChange(r);
  }

  async countInWindow(key: string, windowMs: number): Promise<number> {
    const now = this.now().getTime();
    const recent = (this.calls.get(key) ?? []).filter((at) => at > now - windowMs);
    recent.push(now);
    this.calls.set(key, recent);
    return recent.length;
  }
}
