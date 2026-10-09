CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"region" text NOT NULL,
	"service" text NOT NULL,
	"type" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"state" text,
	"pending_state" text,
	"transition_at" timestamp with time zone,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refs" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "resources_account_kind_idx" ON "resources" USING btree ("account_id","service","type","region");--> statement-breakpoint
CREATE INDEX "resources_refs_idx" ON "resources" USING gin ("refs");