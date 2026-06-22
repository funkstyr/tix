import { integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

import type { OrderRecord } from "@tix/contracts/orders";
import type { PaymentIntentStatus } from "@tix/contracts/payments";
import { defineInbox, defineOutbox } from "@tix/db-core/schema";

// The read-model mirrors the Order aggregate's status, so it speaks the same closed set
// the orders contract defines rather than a bare `string`. Today payments only projects
// `created`/`cancelled`, but deriving from the contract keeps the column honest if more
// order.* events get consumed later.
export type OrderReadModelStatus = OrderRecord["status"];

export const paymentsSchema = pgSchema("payments");

export const payments = paymentsSchema.table("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  // UNIQUE: order_id is the app-level idempotency key. The router relies on
  // INSERT ... ON CONFLICT (order_id) DO NOTHING to dedupe concurrent retries.
  orderId: uuid("order_id").notNull().unique(),
  userId: text("user_id").notNull(),
  stripeId: text("stripe_id").notNull().unique(),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").$type<PaymentIntentStatus>().notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const orderReadModel = paymentsSchema.table("order_read_model", {
  id: uuid("id").primaryKey(),
  version: integer("version").notNull(),
  userId: text("user_id").notNull(),
  priceCents: integer("price_cents").notNull(),
  status: text("status").$type<OrderReadModelStatus>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const paymentsOutbox = defineOutbox(paymentsSchema);

export const paymentsInbox = defineInbox(paymentsSchema);

export const paymentsTables = {
  payments,
  orderReadModel,
  outbox: paymentsOutbox,
  inbox: paymentsInbox,
};
