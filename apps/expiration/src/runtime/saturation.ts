import { Duration, Effect, Metric, Schedule } from "effect";

import { queueDepthGauge } from "./metrics.ts";
import { Scheduler } from "./services.ts";

// Polls BullMQ queue depth every 15s into a gauge (ADR-0011 Tier 1). Forked with
// Effect.forkScoped in index.ts; dies with the scope. A failed counts() call defaults to 0
// for that tick so the poller never dies on a transient Redis blip.
const POLL = Duration.seconds(15);

export const expirationSaturationPoller: Effect.Effect<void, never, Scheduler> = Effect.gen(
  function* () {
    const scheduler = yield* Scheduler;
    const pollOnce = Effect.gen(function* () {
      const c = yield* Effect.tryPromise(() => scheduler.counts()).pipe(
        Effect.catchAll(() => Effect.succeed({ waiting: 0, delayed: 0, active: 0 })),
      );
      yield* Metric.set(queueDepthGauge, c.waiting + c.delayed + c.active);
    });
    yield* pollOnce.pipe(Effect.repeat(Schedule.spaced(POLL)));
  },
);
