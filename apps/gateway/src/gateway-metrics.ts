import { Duration, Effect, Metric, MetricBoundaries } from "effect";

// Edge RED metrics for the gateway (ADR-0009). Effect's MetricRegistry is process-global,
// so these are module constants; the OTLP metrics pipeline (otlpLayer) polls and exports
// them to Prometheus. `instrumentEdge` tags each with the resolved `op` so request rate,
// error rate, and latency are attributable per endpoint.

export const gatewayRequestsTotal = Metric.counter("gateway_requests_total", {
  description: "Edge requests handled.",
  incremental: true,
});

export const gatewayRequestErrorsTotal = Metric.counter("gateway_request_errors_total", {
  description: "Edge requests that failed.",
  incremental: true,
});

// Edge request duration in ms. Exponential buckets from 1ms doubling 16 times (~65s)
// cover sub-ms fan-out through slow upstream timeouts without per-route tuning.
export const gatewayRequestDurationMs = Metric.histogram(
  "gateway_request_duration_ms",
  MetricBoundaries.exponential({ start: 1, factor: 2, count: 16 }),
  "Edge request duration in ms.",
);

// Wraps an edge program: counts the request once, records its wall-clock duration
// regardless of outcome (Effect.timed runs the finalizer on success or failure), and
// counts an error when it fails. All three are tagged with `op` so they aggregate per
// endpoint. Returns the program's value unchanged on success and re-raises on failure.
export function instrumentEdge(op: string) {
  const requests = Metric.tagged(gatewayRequestsTotal, "op", op);
  const errors = Metric.tagged(gatewayRequestErrorsTotal, "op", op);
  const duration = Metric.tagged(gatewayRequestDurationMs, "op", op);

  return <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      yield* Metric.increment(requests);

      const [elapsed, exit] = yield* Effect.timed(Effect.exit(program));

      yield* Metric.update(duration, Duration.toMillis(elapsed));

      if (exit._tag === "Failure") {
        yield* Metric.increment(errors);
      }

      return yield* exit;
    });
}
