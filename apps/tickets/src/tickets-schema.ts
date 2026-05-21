import { integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const ticketsSchema = pgSchema("tickets");

export const tickets = ticketsSchema.table("tickets", {
  id: uuid("id").primaryKey().defaultRandom(),
  sellerId: text("seller_id").notNull(),
  title: text("title").notNull(),
  quantityTotal: integer("quantity_total").notNull(),
  quantityAvailable: integer("quantity_available").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ticketsTables = { tickets };
