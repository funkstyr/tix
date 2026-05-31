import { integer, jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import type { OrderRecord } from "@tix/contracts/orders";
import type { PaymentIntentStatus } from "@tix/contracts/payments";

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

export const paymentsOutbox = paymentsSchema.table("outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  subject: text("subject").notNull(),
  payload: jsonb("payload").notNull(),
  eventId: uuid("event_id").notNull().unique(),
  // W3C traceparent captured at enqueue, replayed into publish headers by the
  // relay (ADR-0009). Nullable: untraced rows publish unchanged.
  traceparent: text("traceparent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export const paymentsInbox = paymentsSchema.table(
  "inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // event_id is text, not uuid: publishers pick their own msgId format (see
    // defineInbox in @tix/db-core for the shared rationale).
    eventId: text("event_id").notNull(),
    subject: text("subject").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("inbox_event_subject_uq").on(t.eventId, t.subject)],
);

export const paymentsTables = {
  payments,
  orderReadModel,
  outbox: paymentsOutbox,
  inbox: paymentsInbox,
};
