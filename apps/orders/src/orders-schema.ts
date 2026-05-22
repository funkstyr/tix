import { integer, jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

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

export const ordersOutbox = ordersSchema.table("outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  subject: text("subject").notNull(),
  payload: jsonb("payload").notNull(),
  eventId: uuid("event_id").notNull().unique(),
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

export const ordersTables = { orders, outbox: ordersOutbox, inbox: ordersInbox };
