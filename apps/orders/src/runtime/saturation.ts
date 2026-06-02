import { count, eq } from "drizzle-orm";
import { Cause, Duration, Effect, Metric, Schedule } from "effect";

import { outboxLag } from "@tix/db-core/outbox-lag";

import { orders, ordersOutbox } from "../domain/schema.ts";
import { outboxLagGauge, pendingOrdersGauge } from "./metrics.ts";
import { Database } from "./services.ts";

// Polls saturation levels every 15s and writes them to gauges (ADR-0011 Tier 1). Forked with
// `Effect.forkScoped` in index.ts alongside the outbox relay; the fiber dies with the scope on
// shutdown. Each poll is failure-isolated (outboxLag swallows its own errors; the pending-count
// query is guarded here) so a transient DB blip never kills the poller.
const POLL = Duration.seconds(15);

export const ordersSaturationPoller: Effect.Effect<void, never, Database> = Effect.gen(
  function* () {
    const db = yield* Database;

    const pollOnce = Effect.gen(function* () {
      const lag = yield* outboxLag(db.db, ordersOutbox);
      yield* Metric.set(outboxLagGauge, lag);

      const pending = yield* Effect.tryPromise(() =>
        db.db.select({ value: count() }).from(orders).where(eq(orders.status, "created")),
      ).pipe(
        Effect.map((rows) => rows[0]?.value ?? 0),
        Effect.catchAllCause((cause) =>
          Effect.logError("pending-orders gauge query failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            Effect.as(0),
          ),
        ),
      );
      yield* Metric.set(pendingOrdersGauge, pending);
    });

    yield* pollOnce.pipe(Effect.repeat(Schedule.spaced(POLL)));
  },
);
