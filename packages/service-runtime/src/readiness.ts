import { Duration, Effect, ManagedRuntime } from "effect";

// Dependency-aware readiness (ADR-0011 Tier 1). Framework-agnostic on purpose: it returns
// a `{ status, body }` pair so each Hono app can `c.json(body, status)` without this package
// taking a Hono dependency. Each check is an Effect that succeeds when its dependency is
// reachable and fails otherwise; every check is bounded by `timeoutMs` so a hung dependency
// fails fast rather than stalling the probe. A single failed check flips the whole report to
// 503 — Kubernetes then sheds traffic from this pod until the dependency returns.

export type ReadinessCheck<R> = {
  readonly name: string;
  // Succeeds → "ok"; fails or times out → "failed". Value is ignored.
  readonly effect: Effect.Effect<unknown, unknown, R>;
};

export type ReadinessReport = {
  readonly status: 200 | 503;
  readonly body: {
    readonly service: string;
    readonly ready: boolean;
    readonly checks: Record<string, "ok" | "failed">;
  };
};

export async function runReadiness<R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  service: string,
  checks: ReadonlyArray<ReadinessCheck<R>>,
  timeoutMs = 2000,
): Promise<ReadinessReport> {
  const program = Effect.forEach(
    checks,
    (check) =>
      check.effect.pipe(
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMs),
          onTimeout: () => new Error(`${check.name} timed out`),
        }),
        Effect.match({
          onFailure: () => [check.name, "failed"] as const,
          onSuccess: () => [check.name, "ok"] as const,
        }),
      ),
    { concurrency: "unbounded" },
  );

  const entries = await runtime.runPromise(program);
  const result: Record<string, "ok" | "failed"> = {};
  for (const [name, state] of entries) result[name] = state;

  const ready = entries.every(([, state]) => state === "ok");
  return {
    status: ready ? 200 : 503,
    body: { service, ready, checks: result },
  };
}
