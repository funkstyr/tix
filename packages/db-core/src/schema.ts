import { jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export function defineOutbox(schemaName: string) {
  return pgSchema(schemaName).table("outbox", {
    id: uuid("id").primaryKey().defaultRandom(),
    subject: text("subject").notNull(),
    payload: jsonb("payload").notNull(),
    eventId: uuid("event_id").notNull().unique(),
    // W3C `traceparent` captured at enqueue time, replayed into the publish
    // headers by the relay so the consumer's span links back to the business
    // operation that produced the event. Nullable: rows enqueued without an
    // active trace publish exactly as before (ADR-0009).
    traceparent: text("traceparent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  });
}

export function defineInbox(schemaName: string) {
  return pgSchema(schemaName).table(
    "inbox",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      // event_id is `text`, not `uuid`: publishers pick their own msgId format
      // (e.g. expiration publishes `expired:<orderId>` for retry-safe JetStream
      // dedup), and the inbox shouldn't constrain that.
      eventId: text("event_id").notNull(),
      subject: text("subject").notNull(),
      consumedAt: timestamp("consumed_at", { withTimezone: true }).defaultNow().notNull(),
    },
    (t) => [unique("inbox_event_subject_uq").on(t.eventId, t.subject)],
  );
}
