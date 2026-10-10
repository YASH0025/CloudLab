import {
  boolean,
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

/**
 * File contents for storage objects, kept apart from `resources` so listing a
 * bucket never loads the bytes. `id` is the object's resource ID; data is base64.
 */
export const blobs = pgTable(
  "blobs",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    data: text("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("blobs_account_idx").on(t.accountId)],
);

// ---------- Local mode: the learner's own computer ----------

/** A computer paired with an account. The agent authenticates with a token; only its hash is kept. */
export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    info: jsonb("info").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [index("agents_account_idx").on(t.accountId)],
);

/** Work queued for an agent: deploy, start, stop, restart, remove. */
export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    accountId: text("account_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_tasks_agent_status_idx").on(t.agentId, t.status)],
);

/** Apps deployed to a learner's computer. Everything but the keys lives in `data`. */
export const localApps = pgTable(
  "local_apps",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    agentId: text("agent_id").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("local_apps_account_idx").on(t.accountId)],
);

// ---------- sign-in (better-auth) ----------
// Standard better-auth tables. A signed-in user's lab lives under the account ID "u_<user.id>".

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);
