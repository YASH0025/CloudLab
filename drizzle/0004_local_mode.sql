CREATE TABLE "agent_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"account_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"info" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "agents_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "local_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_tasks_agent_status_idx" ON "agent_tasks" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "agents_account_idx" ON "agents" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "local_apps_account_idx" ON "local_apps" USING btree ("account_id");