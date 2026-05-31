import { Duration, Effect, Metric, MetricBoundaries } from "effect";

// The closed set of operations RED metrics are tagged by: the four oRPC handlers plus
// `native`, the aggregate bucket for the SPA-facing better-auth `/api/auth/*` surface.
// A union (not a bare string) keeps a typo from silently forking a new metric series.
export type AuthOp = "signUp" | "signIn" | "signOut" | "getSession" | "native";

// RED metrics for the auth service (ADR-0009). Effect's MetricRegistry is process-global,
// so these are module constants; the OTLP metrics pipeline (otlpLayer) polls and exports
// them to Prometheus. `instrumentAuth` tags each with the resolved `op` so request rate,
// error rate, and latency are attributable per operation — sign-in failure rate is just
// the `signIn` error series.

export const authRequestsTotal = Metric.counter("auth_requests_total", {
  description: "Auth requests handled.",
  incremental: true,
});

export const authRequestErrorsTotal = Metric.counter("auth_request_errors_total", {
  description: "Auth requests that failed.",
  incremental: true,
});

// Auth request duration in ms. Exponential buckets from 1ms doubling up to ~16s cover a
// fast in-memory session lookup through a slow password hash without per-op tuning.
export const authRequestDurationMs = Metric.histogram(
  "auth_request_duration_ms",
  MetricBoundaries.exponential({ start: 1, factor: 2, count: 16 }),
  "Auth request duration in ms.",
);

// auth sits on the request path of every authenticated call via `requireSession`, so the
// volume of session validations and how many resolve to a live session (vs. a rejected
// token) is the high-value business signal — and it is *not* an error, so RED can't see
// it. Tagged `result=valid|invalid`.
export const authSessionValidationsTotal = Metric.counter("auth_session_validations_total", {
  description: "Session validations, tagged by whether the token resolved to a live session.",
  incremental: true,
});

// Wraps an auth handler program: counts the request once, records its wall-clock duration
// regardless of outcome (Effect.timed runs on success or failure), and counts an error
// when it fails. All three are tagged with `op` so they aggregate per operation. Returns
// the program's value unchanged on success and re-raises on failure.
export function instrumentAuth(op: AuthOp) {
  const requests = Metric.tagged(authRequestsTotal, "op", op);
  const errors = Metric.tagged(authRequestErrorsTotal, "op", op);
  const duration = Metric.tagged(authRequestDurationMs, "op", op);

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

// Records the outcome of a session validation: `valid` when the token resolved to a live
// session, `invalid` when it did not. getSession returning null is a normal, non-error
// path, so this counter — not the RED error series — carries the rejection rate.
export function recordSessionValidation(valid: boolean): Effect.Effect<void> {
  return Metric.increment(
    Metric.tagged(authSessionValidationsTotal, "result", valid ? "valid" : "invalid"),
  );
}
