import type { Engine } from "@/engine/engine";
import { statsOf, type TableStats } from "@/engine/dynamodb/items";
import type { Resource } from "@/engine/types";

/** The table the DynamoDB tutorial suggests. */
export const TUTORIAL_TABLE = "Orders";

/** What the DynamoDB tutorial looks at. */
export interface NosqlState {
  table?: Resource;
  stats: TableStats;
  itemCount: number;
  /** Some partition holds two or more items (needs a sort key). */
  sharedPartition: boolean;
  /** A global secondary index on the table. */
  index?: { indexName: string; partitionKey: string; sortKey?: string };
}

export async function loadNosql(engine: Engine, accountId: string, region: string): Promise<NosqlState> {
  const tables = await engine.list(accountId, { service: "dynamodb", type: "table", region });
  const table = tables.find((t) => t.name === TUTORIAL_TABLE) ?? tables[0];
  const items = Object.values((table?.attributes.items as Record<string, Record<string, unknown>> | undefined) ?? {});
  const pk = String(table?.config.partitionKey ?? "");
  const counts = new Map<string, number>();
  for (const it of items) {
    const k = JSON.stringify(it[pk]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const index = ((table?.config.globalSecondaryIndexes as { indexName: string; partitionKey: string; sortKey?: string }[] | undefined) ?? [])[0];
  return {
    table,
    stats: table ? statsOf(table) : statsOf({ attributes: {} } as Resource),
    itemCount: items.length,
    sharedPartition: [...counts.values()].some((n) => n >= 2),
    index,
  };
}
