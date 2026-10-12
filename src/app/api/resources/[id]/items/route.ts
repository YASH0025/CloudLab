import type { NextRequest } from "next/server";
import { z } from "zod";
import { deleteItem, putItem, query, scan } from "@/engine/dynamodb/items";
import { executeStatement } from "@/engine/dynamodb/partiql";
import { marshall, marshallItem, unmarshallItem, type Item } from "@/engine/dynamodb/values";
import { EngineError } from "@/engine/errors";
import { authorizeActions, getCaller, getEngine, handle } from "@/server/api";

/**
 * The table page's "Explore items": scan or query (the table or an index),
 * create or replace an item, delete one. Items go in and out as plain JSON,
 * the way the DynamoDB console shows them; the engine works in DynamoDB JSON.
 */

const sortOps = ["=", "<", "<=", ">", ">=", "begins_with", "between"] as const;
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("scan"), indexName: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) }),
  z.object({
    action: z.literal("query"),
    indexName: z.string().optional(),
    partitionValue: z.union([z.string(), z.number()]),
    sort: z.object({ op: z.enum(sortOps), value: z.union([z.string(), z.number()]), value2: z.union([z.string(), z.number()]).optional() }).optional(),
    forward: z.boolean().default(true),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  z.object({ action: z.literal("put"), item: z.record(z.string(), z.unknown()), mustBeNew: z.boolean().default(false) }),
  z.object({ action: z.literal("delete"), key: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal("statement"), statement: z.string().max(8192) }),
]);

export async function POST(request: NextRequest, ctx: RouteContext<"/api/resources/[id]/items">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const input = body.parse(await request.json().catch(() => ({})));
    const caller = await getCaller();
    const engine = getEngine();
    const t = await engine.get(caller.accountId, id);
    if (t.service !== "dynamodb" || t.type !== "table") throw new EngineError("ValidationError", "Only DynamoDB tables have items.");
    const plain = (items: Item[] | undefined) => (items ?? []).map(unmarshallItem);
    const indexArn = (name?: string) => (name ? `${t.id}/index/${name}` : t.id);

    switch (input.action) {
      case "scan": {
        authorizeActions(caller, [{ action: "dynamodb:Scan", resource: indexArn(input.indexName) }]);
        const r = await scan(engine, t, { indexName: input.indexName, limit: input.limit });
        return Response.json({ items: plain(r.Items), count: r.Count, scannedCount: r.ScannedCount, more: !!r.LastEvaluatedKey });
      }
      case "query": {
        authorizeActions(caller, [{ action: "dynamodb:Query", resource: indexArn(input.indexName) }]);
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
        const r = await query(engine, t, { keyCondition: expr, names, values, indexName: input.indexName, scanIndexForward: input.forward, limit: input.limit });
        return Response.json({ items: plain(r.Items), count: r.Count, scannedCount: r.ScannedCount, more: !!r.LastEvaluatedKey, expression: expr });
      }
      case "put": {
        authorizeActions(caller, [{ action: "dynamodb:PutItem", resource: t.id }]);
        const item = marshallItem(input.item);
        await putItem(engine, t, item, input.mustBeNew ? { condition: "attribute_not_exists(#pk)", names: { "#pk": String(t.config.partitionKey) } } : {});
        return Response.json({ saved: true });
      }
      case "statement": {
        const verb = input.statement.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
        const action = { INSERT: "dynamodb:PartiQLInsert", UPDATE: "dynamodb:PartiQLUpdate", DELETE: "dynamodb:PartiQLDelete" }[verb] ?? "dynamodb:PartiQLSelect";
        authorizeActions(caller, [{ action, resource: t.id }]);
        const r = await executeStatement(engine, caller.accountId, t.region, input.statement);
        return Response.json({ items: r.Items ? plain(r.Items) : undefined, ranAs: r.ranAs, index: r.index, scannedCount: r.scannedCount, translated: r.translated });
      }
      case "delete": {
        authorizeActions(caller, [{ action: "dynamodb:DeleteItem", resource: t.id }]);
        await deleteItem(engine, t, marshallItem(input.key));
        return Response.json({ deleted: true });
      }
    }
  });
}
