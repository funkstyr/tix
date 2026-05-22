import { integer, jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

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

export const ticketsOutbox = ticketsSchema.table("outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  subject: text("subject").notNull(),
  payload: jsonb("payload").notNull(),
  eventId: uuid("event_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export const ticketsInbox = ticketsSchema.table(
  "inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull(),
    subject: text("subject").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("inbox_event_subject_uq").on(t.eventId, t.subject)],
);

export const ticketsTables = { tickets, outbox: ticketsOutbox, inbox: ticketsInbox };
