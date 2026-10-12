import type { Engine } from "@/engine/engine";
import { statsOf } from "@/engine/dynamodb/items";
import type { Suggestion } from "./types";

/**
 * Advisor rules for DynamoDB: a provisioned table that's being throttled, and
 * a table read mostly by Scan (a sign the key doesn't fit how it's used).
 */
export async function dynamodbAdvice(engine: Engine, accountId: string, region: string) {
  const tables = await engine.list(accountId, { service: "dynamodb", type: "table", region });
  const now = engine.now().getTime();
  const problems: Suggestion[] = [];
  const suggestions: Suggestion[] = [];
  for (const t of tables) {
    const at = t.attributes.throttledAt ? Date.parse(String(t.attributes.throttledAt)) : 0;
    if (t.config.billingMode === "PROVISIONED" && now - at < 15 * 60_000) {
      problems.push({
        id: `ddb-throttled-${t.id}`,
        level: "intermediate",
        title: `${t.name} is rejecting requests (throttled)`,
        why: `It's provisioned for ${String(t.config.readCapacity)} reads and ${String(t.config.writeCapacity)} writes per second, and got more. Extra requests fail with ProvisionedThroughputExceededException.`,
        steps: ["Edit the table: raise the capacity units, or switch Capacity mode to On-demand so it scales by itself.", "Clients should retry throttled requests with backoff (the AWS SDKs do)."],
        link: { service: "dynamodb", type: "table", mode: "detail", id: t.id },
        cli: `aws dynamodb update-table --table-name ${t.name} --billing-mode PAY_PER_REQUEST`,
      });
    }
    const s = statsOf(t);
    if (s.scans >= 5 && s.scans > 2 * (s.queries + s.reads)) {
      suggestions.push({
        id: `ddb-scan-heavy-${t.id}`,
        level: "intermediate",
        title: `${t.name} is read mostly with Scan`,
        why: "A Scan reads (and bills) every item, then filters. It gets slower as the table grows. If you keep filtering on the same attribute, query by it instead.",
        steps: ["Look at what your scans filter on.", "Add a global secondary index with that attribute as its partition key, and Query the index."],
        link: { service: "dynamodb", type: "table", mode: "detail", id: t.id },
      });
    }
  }
  return { problems, suggestions };
}
