import * as HttpClient from "@effect/platform/HttpClient";
import { Duration, Effect, Schedule } from "effect";

// How long to wait for the collector before giving up and starting anyway. Sized for the
// cold-boot window: in kind the gateway collector becomes Ready ~45s after the app pods, so
// 60s covers it with margin. We never wait forever — a genuinely-down collector must not
// couple service availability to telemetry.
const DEFAULT_PROBE_TIMEOUT = Duration.seconds(60);
const PROBE_RETRY_BASE = Duration.millis(200);

// Parse the readiness budget from `OTEL_COLLECTOR_READY_TIMEOUT_MS`. The gate is opt-in: real
// deployments set this (pulumi puts it on every backend service) to wait for the collector at
// boot; unset / "0" / garbage → `undefined`, meaning *don't gate* — the exporter builds
// immediately. That keeps tests and any consumer that hasn't opted in from blocking layer
// construction on a network probe, and keeps app readiness from coupling to the collector unless
// an operator chose that trade per stack.
export function readinessTimeoutFromEnv(raw: string | undefined): Duration.Duration | undefined {
  if (raw === undefined) return undefined;

  const ms = Number(raw);

  return Number.isFinite(ms) && ms > 0 ? Duration.millis(ms) : undefined;
}

// Block until the OTLP collector accepts a connection, then resolve. The `@effect/opentelemetry`
// exporter (internal/otlpExporter.js) self-disables for 60s after a single failed export AND
// drops every log pushed during that window — so if the collector isn't up when a service's
// first batch flushes (~1s after boot), the whole first minute of logs is lost. A service that
// only logs at startup (gateway, tickets, auth) then appears to emit nothing at all. Probing
// here keeps the exporter's first flush from racing a cold collector.
//
// "Reachable" means any HTTP response — even a 404 from the OTLP base path proves the listener
// is up; only transport errors (connection refused, DNS) are retried. After the timeout we log
// and return void: the layer builds, the exporter starts, and we accept the same loss as before
// rather than wedge boot on a down collector.
export function awaitCollector(
  baseUrl: string,
  options?: { readonly timeout?: Duration.DurationInput },
): Effect.Effect<void, never, HttpClient.HttpClient> {
  const timeout = options?.timeout ?? DEFAULT_PROBE_TIMEOUT;

  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const probe = client.get(baseUrl).pipe(Effect.scoped, Effect.asVoid);

    yield* probe.pipe(
      Effect.retry(Schedule.exponential(PROBE_RETRY_BASE).pipe(Schedule.jittered)),
      Effect.timeout(timeout),
      Effect.catchAll(() =>
        Effect.logWarning(
          `OTLP collector unreachable at ${baseUrl} after ${Duration.format(timeout)}; ` +
            "starting anyway — early telemetry may be dropped until it recovers",
        ),
      ),
    );
  });
}
