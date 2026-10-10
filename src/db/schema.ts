import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Every simulated resource of every service lives in this one table.
 * Service-specific settings go in `config` (what the user chose) and
 * `attributes` (what the platform derived, e.g. assigned IPs).
 */
export const resources = pgTable(
  "resources",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    region: text("region").notNull(),
    service: text("service").notNull(),
    type: text("type").notNull(),
    name: text("name").notNull().default(""),
    /** Current lifecycle state, e.g. "pending", "running". Null for stateless resources. */
    state: text("state"),
    /** State the resource will settle into once `transitionAt` has passed. */
    pendingState: text("pending_state"),
    transitionAt: timestamp("transition_at", { withTimezone: true }),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    /** IDs of other resources this one points at; used for dependency checks. */
    refs: text("refs").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("resources_account_kind_idx").on(t.accountId, t.service, t.type, t.region),
    index("resources_refs_idx").using("gin", t.refs),
  ],
);

export type ResourceRow = typeof resources.$inferSelect;

/** One-off keys, e.g. "this account's default VPC in us-east-1 has been created". */
export const claims = pgTable("claims", {
  key: text("key").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
