import { sql } from "drizzle-orm";
import { check, index, integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { defineInbox, defineOutbox } from "@tix/db-core/schema";

export const ticketsSchema = pgSchema("tickets");

export const tickets = ticketsSchema.table(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sellerId: text("seller_id").notNull(),
    title: text("title").notNull(),
    quantityTotal: integer("quantity_total").notNull(),
    quantityAvailable: integer("quantity_available").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "tickets_quantity_available_bounds",
      sql`${t.quantityAvailable} >= 0 AND ${t.quantityAvailable} <= ${t.quantityTotal}`,
    ),
    // keyset support for the price sorts and the default newest sort
    index("tickets_unit_price_id_idx").on(t.unitPriceCents, t.id),
    index("tickets_created_at_id_idx").on(t.createdAt.desc(), t.id.desc()),
  ],
);

export const ticketsOutbox = defineOutbox(ticketsSchema);

export const ticketsInbox = defineInbox(ticketsSchema);

export const ticketsTables = { tickets, outbox: ticketsOutbox, inbox: ticketsInbox };
