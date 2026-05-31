import { integer, jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const ordersSchema = pgSchema("orders");

export const orders = ordersSchema.table("orders", {
  // `defaultRandom()` is a fallback safety net; the router always assigns an
  // explicit uuidv7 so `orders.list` can use `desc(id)` as a millisecond
  // tie-break that preserves insert order. Don't add a writer that relies on
  // the SQL default without revisiting that ordering.
  id: uuid("id").primaryKey().defaultRandom(),
  buyerId: text("buyer_id").notNull(),
  ticketId: uuid("ticket_id").notNull(),
  quantity: integer("quantity").notNull(),
  priceCents: integer("price_cents").notNull(),
  status: text("status", {
    enum: ["created", "awaiting_payment", "complete", "cancelled", "expired"],
  }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Read-model replica of the tickets service's catalog, fed by tickets.created.v1
// and tickets.updated.v1. Orders keeps its own copy of seller-facing ticket
// fields (title/price) so it never has to fan out to tickets for display. The
// authoritative row — and the reservation invariants — still live in tickets.
export const ticketsReplica = ordersSchema.table("tickets_replica", {
  id: uuid("id").primaryKey(),
  sellerId: text("seller_id").notNull(),
  title: text("title").notNull(),
  quantityTotal: integer("quantity_total").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const ordersOutbox = ordersSchema.table("outbox", {
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

export const ordersInbox = ordersSchema.table(
  "inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // event_id is text, not uuid: publishers pick their own msgId format.
    eventId: text("event_id").notNull(),
    subject: text("subject").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("inbox_event_subject_uq").on(t.eventId, t.subject)],
);

export const ordersTables = {
  orders,
  ticketsReplica,
  outbox: ordersOutbox,
  inbox: ordersInbox,
};
