import { count, isNull } from "drizzle-orm";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Cause, Effect } from "effect";

import { type OutboxTable } from "./outbox.js";

type AnyDb = PostgresJsDatabase<Record<string, unknown>>;

// Outbox lag = un-relayed rows (`sentAt IS NULL`). A saturation level (ADR-0011 Tier 1): a
// growing value means the relay is falling behind its publish rate. Polled, not event-driven —
// a row sitting un-relayed emits nothing. Never throws: a query failure logs and reports 0 so
// the poller fiber stays alive (a dead poller is worse than a stale gauge).
export function outboxLag(db: AnyDb, table: OutboxTable): Effect.Effect<number, never, never> {
  return Effect.tryPromise(() =>
    db.select({ value: count() }).from(table).where(isNull(table.sentAt)),
  ).pipe(
    Effect.map((rows) => rows[0]?.value ?? 0),
    Effect.catchAllCause((cause) =>
      Effect.logError("outbox lag query failed").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        Effect.as(0),
      ),
    ),
  );
}
