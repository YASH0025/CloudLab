CREATE TABLE "blobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "blobs_account_idx" ON "blobs" USING btree ("account_id");