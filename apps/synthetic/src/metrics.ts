import { Effect, Metric, MetricBoundaries } from "effect";

// Outcome of each synthetic buyer journey, labeled success/failure so the probe-failure alert can
// fire on the failure series and the synthetics board can chart the success ratio.
export const syntheticJourneyTotal = Metric.counter("synthetic_journey_total", {
  description: "Synthetic buyer-journey probe runs, by result.",
  incremental: true,
});

// End-to-end journey wall-clock in milliseconds (sign-in -> charge -> cleanup).
export const syntheticJourneyDurationMs = Metric.histogram(
  "synthetic_journey_duration_ms",
  MetricBoundaries.exponential({ start: 50, factor: 2, count: 12 }),
  "Synthetic buyer-journey total duration in milliseconds.",
);

export function recordJourney(ok: boolean, durationMs: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* Metric.increment(
      Metric.tagged(syntheticJourneyTotal, "result", ok ? "success" : "failure"),
    );
    yield* Metric.update(syntheticJourneyDurationMs, durationMs);
  });
}
