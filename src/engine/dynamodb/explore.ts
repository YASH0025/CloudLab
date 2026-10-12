import type { Resource } from "../types";
import type { TableHost } from "../host";
import { deleteItem, putItem, query, scan } from "./items";
import { executeStatement } from "./partiql";
import { marshall, marshallItem, unmarshallItem, type Item } from "./values";

/**
 * The table page's "Explore items": scan or query (the table or an index),
 * create or replace an item, delete one, or run a PartiQL statement. Items go in
 * and out as plain JSON, the way the DynamoDB console shows them. The same code
 * runs on CloudLab's servers and, for tables on My computer (local), in the agent.
 */

type Scalar = string | number;
export type ExploreInput =
  | { action: "scan"; indexName?: string; limit: number }
  | {
      action: "query";
      indexName?: string;
      partitionValue: Scalar;
      sort?: { op: "=" | "<" | "<=" | ">" | ">=" | "begins_with" | "between"; value: Scalar; value2?: Scalar };
      forward: boolean;
      limit: number;
    }
  | { action: "put"; item: Record<string, unknown>; mustBeNew: boolean }
  | { action: "delete"; key: Record<string, unknown> }
  | { action: "statement"; statement: string };

/** The IAM action an explore request needs, and the resource it's on. */
export function exploreAction(t: Resource, input: ExploreInput): { action: string; resource: string } {
  const indexArn = (name?: string) => (name ? `${t.id}/index/${name}` : t.id);
  switch (input.action) {
    case "scan":
      return { action: "dynamodb:Scan", resource: indexArn(input.indexName) };
    case "query":
      return { action: "dynamodb:Query", resource: indexArn(input.indexName) };
    case "put":
      return { action: "dynamodb:PutItem", resource: t.id };
    case "delete":
      return { action: "dynamodb:DeleteItem", resource: t.id };
    case "statement": {
      const verb = input.statement.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
      return { action: { INSERT: "dynamodb:PartiQLInsert", UPDATE: "dynamodb:PartiQLUpdate", DELETE: "dynamodb:PartiQLDelete" }[verb] ?? "dynamodb:PartiQLSelect", resource: t.id };
    }
  }
}

export async function explore(host: TableHost, t: Resource, input: ExploreInput) {
  const plain = (items: Item[] | undefined) => (items ?? []).map(unmarshallItem);
  switch (input.action) {
    case "scan": {
      const r = await scan(host, t, { indexName: input.indexName, limit: input.limit });
      return { items: plain(r.Items), count: r.Count, scannedCount: r.ScannedCount, more: !!r.LastEvaluatedKey };
    }
    case "query": {
      const idx = input.indexName ? ((t.config.globalSecondaryIndexes as Record<string, unknown>[] | undefined) ?? []).find((g) => g.indexName === input.indexName) : null;
      const pk = String(idx ? idx.partitionKey : t.config.partitionKey);
      const pkType = String(idx ? idx.partitionKeyType : t.config.partitionKeyType);
      const sk = idx ? (idx.sortKey as string | undefined) : (t.config.sortKey as string | undefined);
      const skType = String(idx ? (idx.sortKeyType ?? "S") : (t.config.sortKeyType ?? "S"));
      // Values are typed by the key's type, so "42" queries a Number key as 42.
      const typed = (v: string | number, type: string) => (type === "N" ? { N: String(v) } : type === "B" ? { B: String(v) } : { S: String(v) });
      const names: Record<string, string> = { "#pk": pk };
      const values: Record<string, ReturnType<typeof marshall>> = { ":pk": typed(input.partitionValue, pkType) };
      let expr = "#pk = :pk";
      if (input.sort && sk) {
        names["#sk"] = sk;
        values[":sk"] = typed(input.sort.value, skType);
        if (input.sort.op === "begins_with") expr += " AND begins_with(#sk, :sk)";
        else if (input.sort.op === "between") {
          values[":sk2"] = typed(input.sort.value2 ?? input.sort.value, skType);
          expr += " AND #sk BETWEEN :sk AND :sk2";
        } else expr += ` AND #sk ${input.sort.op} :sk`;
      }
      const r = await query(host, t, { keyCondition: expr, names, values, indexName: input.indexName, scanIndexForward: input.forward, limit: input.limit });
      return { items: plain(r.Items), count: r.Count, scannedCount: r.ScannedCount, more: !!r.LastEvaluatedKey, expression: expr };
    }
    case "put": {
      const item = marshallItem(input.item);
      await putItem(host, t, item, input.mustBeNew ? { condition: "attribute_not_exists(#pk)", names: { "#pk": String(t.config.partitionKey) } } : {});
      return { saved: true };
    }
    case "statement": {
      const r = await executeStatement(host, t.accountId, t.region, input.statement);
      return { items: r.Items ? plain(r.Items) : undefined, ranAs: r.ranAs, index: r.index, scannedCount: r.scannedCount, translated: r.translated };
    }
    case "delete": {
      await deleteItem(host, t, marshallItem(input.key));
      return { deleted: true };
    }
  }
}
