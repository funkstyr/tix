import { Data, Duration, Effect, Metric, Ref, Schedule } from "effect";

export type ResilienceOptions<E> = {
  timeout?: Duration.DurationInput;
  maxRetries?: number;
  retryBase?: Duration.DurationInput;
  isRetryable?: (error: E) => boolean;
};

const DEFAULT_TIMEOUT = Duration.seconds(5);
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE = Duration.millis(100);

// Resilience counters, tagged per `operation` at use. Effect's MetricRegistry is
// process-global, so these are module constants the OTLP metrics pipeline exports for free
// (ADR-0009). Exported so dashboards — and tests — can read them by name.
export const ioRetriesTotal: Metric.Metric.Counter<number> = Metric.counter("io_retries_total", {
  description: "Retries performed by withResilience at an I/O seam.",
  incremental: true,
});

export const ioTimeoutsTotal: Metric.Metric.Counter<number> = Metric.counter("io_timeouts_total", {
  description: "Attempts that exceeded their resilience timeout.",
  incremental: true,
});

// Internal signal raised when an attempt exceeds its timeout. It rides the typed `E`
// channel only inside this module so the retry schedule can recognise it; it is converted
// to a defect before the combinator returns, so it never widens a caller's error type.
class ResilienceTimeout extends Data.TaggedError("ResilienceTimeout")<{
  operation: string;
}> {}

function isTimeout(error: unknown): error is ResilienceTimeout {
  return error instanceof ResilienceTimeout;
}

// A surviving timeout becomes a defect so the combinator's public error channel stays `E` —
// applying it at a seam never widens the caller's error type. A hung dependency surfaces as
// a 500 through the existing `Cause.squash` path, just like any other unexpected failure.
function dieOnTimeout<A, E, R>(
  effect: Effect.Effect<A, E | ResilienceTimeout, R>,
): Effect.Effect<A, E, R> {
  return effect.pipe(Effect.catchIf(isTimeout, (error) => Effect.die(error)));
}

type RunOptions<E> = ResilienceOptions<E> & { retry: boolean };

function run<A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
  options: RunOptions<E>,
): Effect.Effect<A, E, R> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBase = options.retryBase ?? DEFAULT_RETRY_BASE;
  const isRetryable = options.isRetryable ?? (() => false);

  const retries = Metric.tagged(ioRetriesTotal, "operation", operation);
  const timeouts = Metric.tagged(ioTimeoutsTotal, "operation", operation);

  return Effect.gen(function* () {
    const retryCount = yield* Ref.make(0);
    const timedOut = yield* Ref.make(false);

    // One bounded attempt: the effect interrupted at `timeout`, with a timeout surfacing as
    // the internal `ResilienceTimeout` signal so the schedule and the final die can see it.
    const attempt = effect.pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () => new ResilienceTimeout({ operation }),
      }),
      Effect.tapError((error) =>
        isTimeout(error)
          ? Metric.increment(timeouts).pipe(Effect.zipRight(Ref.set(timedOut, true)))
          : Effect.void,
      ),
    );

    const schedule = Schedule.exponential(retryBase).pipe(
      Schedule.jittered,
      Schedule.intersect(Schedule.recurs(maxRetries)),
      Schedule.tapOutput(() =>
        Metric.increment(retries).pipe(Effect.zipRight(Ref.update(retryCount, (n) => n + 1))),
      ),
    );

    const retried = options.retry
      ? attempt.pipe(
          Effect.retry({
            schedule,
            while: (error) => (isTimeout(error) ? true : isRetryable(error)),
          }),
        )
      : attempt;

    return yield* retried.pipe(
      dieOnTimeout,
      Effect.onExit(() =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("retry.count", yield* Ref.get(retryCount));
          yield* Effect.annotateCurrentSpan("timed_out", yield* Ref.get(timedOut));
        }),
      ),
      Effect.withSpan(operation),
    );
  });
}

export function withResilience<A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
  options?: ResilienceOptions<E>,
): Effect.Effect<A, E, R> {
  return run(operation, effect, { ...options, retry: true });
}

export function withTimeout<A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
  options?: Pick<ResilienceOptions<E>, "timeout">,
): Effect.Effect<A, E, R> {
  return run(operation, effect, { ...options, retry: false });
}
