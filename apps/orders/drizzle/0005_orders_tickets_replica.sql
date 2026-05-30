CREATE TABLE "orders"."tickets_replica" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"title" text NOT NULL,
	"quantity_total" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
