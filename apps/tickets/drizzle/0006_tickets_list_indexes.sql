CREATE INDEX "tickets_unit_price_id_idx" ON "tickets"."tickets" USING btree ("unit_price_cents","id");--> statement-breakpoint
CREATE INDEX "tickets_created_at_id_idx" ON "tickets"."tickets" USING btree ("created_at" DESC,"id" DESC);
