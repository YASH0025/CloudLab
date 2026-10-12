import { z } from "zod";
import type { ExploreInput } from "./explore";

/** What the console sends to explore a table's items (checked on the server and by the agent). */
const sortOps = ["=", "<", "<=", ">", ">=", "begins_with", "between"] as const;
export const exploreInput = z.discriminatedUnion("action", [
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

export const parseExplore = (body: unknown): ExploreInput => exploreInput.parse(body);
