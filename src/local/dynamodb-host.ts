import type { Resource } from "@/engine/types";
import { tableNotFound } from "@/engine/services/dynamodb";
import { FileResourceHost, type ResourceSpec } from "./file-host";

export type TableSpec = ResourceSpec;

/** What CloudLab shows about a table on this computer: counts, never the items themselves. */
export interface TableReport {
  itemCount: number;
  tableSizeBytes: number;
  stats: unknown;
  throttledAt?: unknown;
}

/**
 * DynamoDB tables on the learner's computer: one JSON file per table, holding its
 * settings and items. The agent runs CloudLab's own DynamoDB code against this.
 */
export class FileTableHost extends FileResourceHost {
  constructor(dir: string, onChange: (t: Resource) => void = () => undefined, now: () => Date = () => new Date()) {
    super(dir, "dynamodb", "table", tableNotFound, onChange, now);
  }

  protected initialAttributes() {
    return { items: {}, itemCount: 0, tableSizeBytes: 0 };
  }

  /**
   * Hands out the live item map instead of a copy: copying a 2,000-item map on every
   * call made each write slower as the table grew. That's safe because items are
   * never edited in place (UpdateItem builds a new item), and every write checks
   * its limits before it changes the map (items.ts `write`); transactions keep
   * their own snapshot to roll back to.
   */
  protected copy(t: Resource): Resource {
    return { ...t, config: structuredClone(t.config), refs: [...t.refs], attributes: { ...t.attributes, stats: { ...(t.attributes.stats as object) } } };
  }

  protected specAttributes(spec: TableSpec) {
    return { arn: spec.id };
  }

  report(name: string): TableReport | null {
    const t = this.peek(name);
    if (!t) return null;
    const a = t.attributes;
    return { itemCount: Number(a.itemCount ?? 0), tableSizeBytes: Number(a.tableSizeBytes ?? 0), stats: a.stats ?? {}, ...(a.throttledAt ? { throttledAt: a.throttledAt } : {}) };
  }
}
