CREATE SCHEMA IF NOT EXISTS "expiration";
--> statement-breakpoint
CREATE TABLE "expiration"."inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"subject" text NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_event_subject_uq" UNIQUE("event_id","subject")
);
