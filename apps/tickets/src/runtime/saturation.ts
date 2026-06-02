import { sum } from "drizzle-orm";
import { Cause, Duration, Effect, Metric, Schedule } from "effect";

import { outboxLag } from "@tix/db-core/outbox-lag";

import { tickets, ticketsOutbox } from "../domain/schema.ts";
import { availableInventoryGauge, outboxLagGauge } from "./metrics.ts";
import { Database } from "./services.ts";

const POLL = Duration.seconds(15);

export const ticketsSaturationPoller: Effect.Effect<void, never, Database> = Effect.gen(
  function* () {
    const db = yield* Database;

    const pollOnce = Effect.gen(function* () {
      const lag = yield* outboxLag(db.db, ticketsOutbox);
      yield* Metric.set(outboxLagGauge, lag);

      const available = yield* Effect.tryPromise(() =>
        db.db.select({ value: sum(tickets.quantityAvailable) }).from(tickets),
      ).pipe(
        // drizzle sum() returns a string|null (numeric) — coerce to number, default 0.
        Effect.map((rows) => Number(rows[0]?.value ?? 0)),
        Effect.catchAllCause((cause) =>
          Effect.logError("available-inventory gauge query failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            Effect.as(0),
          ),
        ),
      );
      yield* Metric.set(availableInventoryGauge, available);
    });

    yield* pollOnce.pipe(Effect.repeat(Schedule.spaced(POLL)));
  },
);
