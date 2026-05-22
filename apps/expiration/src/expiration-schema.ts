import { pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const expirationSchema = pgSchema("expiration");

export const expirationInbox = expirationSchema.table(
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

export const expirationTables = { inbox: expirationInbox };
