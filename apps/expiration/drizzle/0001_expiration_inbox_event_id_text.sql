ALTER TABLE "expiration"."inbox" ALTER COLUMN "event_id" SET DATA TYPE text USING "event_id"::text;
