import { Duration, Effect, Layer, Schedule } from "effect";

// A low-frequency INFO heartbeat forked for the service's lifetime. A service that is quiet at
// INFO after boot — the gateway traces every request but logs none, tickets/auth log only at
// startup — otherwise leaves no recent line in Loki, so "is this service logging at all?" can't
// be answered without waiting for organic traffic. The first beat is delayed one full interval so
// it never races the startup/readiness logs. Gated by `LOG_LEVEL` like any INFO line (ADR-0012),
// so prod (warn-and-up) stays silent; there the blackbox probe and request volume are the liveness
// signal. Cheap: one line per service per interval.
const DEFAULT_INTERVAL = Duration.minutes(5);

export function heartbeatLayer(opts: {
  serviceName: string;
  interval?: Duration.DurationInput;
}): Layer.Layer<never> {
  const interval = opts.interval ?? DEFAULT_INTERVAL;

  const beat = Effect.logInfo("heartbeat").pipe(
    Effect.annotateLogs("service.name", opts.serviceName),
  );

  return Layer.scopedDiscard(
    Effect.forkScoped(beat.pipe(Effect.repeat(Schedule.spaced(interval)), Effect.delay(interval))),
  );
}
