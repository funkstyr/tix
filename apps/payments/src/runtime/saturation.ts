import { Duration, Effect, Metric, Schedule } from "effect";

import { outboxLag } from "@tix/db-core/outbox-lag";

import { paymentsOutbox } from "../domain/schema.ts";
import { outboxLagGauge } from "./metrics.ts";
import { Database } from "./services.ts";

// Polls outbox lag every 15s into a gauge (ADR-0011 Tier 1). Forked with Effect.forkScoped in
// index.ts; dies with the scope. outboxLag swallows its own query errors, so the poller never
// dies on a transient DB blip.
const POLL = Duration.seconds(15);

export const paymentsSaturationPoller: Effect.Effect<void, never, Database> = Effect.gen(
  function* () {
    const db = yield* Database;
    const pollOnce = Effect.gen(function* () {
      const lag = yield* outboxLag(db.db, paymentsOutbox);
      yield* Metric.set(outboxLagGauge, lag);
    });
    yield* pollOnce.pipe(Effect.repeat(Schedule.spaced(POLL)));
  },
);
