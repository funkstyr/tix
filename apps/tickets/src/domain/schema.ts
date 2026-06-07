import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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

export const ticketsOutbox = ticketsSchema.table("outbox", {
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

export const ticketsInbox = ticketsSchema.table(
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

export const ticketsTables = { tickets, outbox: ticketsOutbox, inbox: ticketsInbox };
