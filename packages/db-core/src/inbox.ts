import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { type defineInbox } from "./schema.js";

export type InboxTable = ReturnType<typeof defineInbox>;

// `Record<string, unknown>` accepts any per-service schema via structural typing.
type AnyDb = PostgresJsDatabase<Record<string, unknown>>;

export type InboxDedupeKey = {
  eventId: string;
  subject: string;
};

export type InboxDedupeResult<T> = { deduped: true } | { deduped: false; result: T };

export async function withInboxDedupe<T>(
  tx: AnyDb,
  table: InboxTable,
  { eventId, subject }: InboxDedupeKey,
  handler: () => Promise<T>,
): Promise<InboxDedupeResult<T>> {
  // ON CONFLICT keeps the unique-constraint failure inside Postgres rather than
  // raising an error that would abort the surrounding transaction.
  const inserted = await tx
    .insert(table)
    .values({ eventId, subject })
    .onConflictDoNothing({ target: [table.eventId, table.subject] })
    .returning({ id: table.id });

  if (inserted.length === 0) return { deduped: true };

  const result = await handler();
  return { deduped: false, result };
}
