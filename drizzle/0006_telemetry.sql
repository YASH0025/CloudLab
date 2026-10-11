CREATE TABLE IF NOT EXISTS "log_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"region" text NOT NULL,
	"log_group" text NOT NULL,
	"log_stream" text NOT NULL,
	"timestamp" timestamp (3) with time zone NOT NULL,
	"ingested_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_data" (
	"account_id" text NOT NULL,
	"region" text NOT NULL,
	"namespace" text NOT NULL,
	"metric_name" text NOT NULL,
	"dimensions" text NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"sum" double precision NOT NULL,
	"count" double precision NOT NULL,
	"min" double precision NOT NULL,
	"max" double precision NOT NULL,
	"unit" text DEFAULT 'None' NOT NULL,
	CONSTRAINT "metric_data_account_id_region_namespace_metric_name_dimensions_minute_pk" PRIMARY KEY("account_id","region","namespace","metric_name","dimensions","minute")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_events_group_time" ON "log_events" USING btree ("account_id","region","log_group","timestamp");