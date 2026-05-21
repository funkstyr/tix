import { integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const ordersSchema = pgSchema("orders");

export const orders = ordersSchema.table("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  buyerId: text("buyer_id").notNull(),
  ticketId: uuid("ticket_id").notNull(),
  quantity: integer("quantity").notNull(),
  status: text("status").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ordersTables = { orders };
