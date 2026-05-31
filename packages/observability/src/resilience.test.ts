import { expect, it } from "@effect/vitest";
import {
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  Metric,
  Option,
  Ref,
  TestClock,
  type Tracer,
} from "effect";

import { ioRetriesTotal, ioTimeoutsTotal, withResilience, withTimeout } from "./resilience.ts";

class FlakyError extends Data.TaggedError("FlakyError")<{ reason: string }> {}

const FAST = { timeout: Duration.seconds(1), retryBase: Duration.millis(100), maxRetries: 3 };

it.effect("withTimeout dies when the operation exceeds the timeout", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(withTimeout("test.timeout.die", Effect.never));

    yield* TestClock.adjust(Duration.seconds(5));

    const polled = yield* Fiber.poll(fiber);
    expect(Option.isSome(polled)).toBe(true);

    const exit = Option.getOrThrow(polled);
    expect(Exit.isFailure(exit) && Option.isSome(Cause.dieOption(exit.cause))).toBe(true);
  }),
);

it.effect("withResilience returns the value without retrying when the effect succeeds", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);

    const value = yield* withResilience(
      "test.success",
      Ref.updateAndGet(attempts, (n) => n + 1).pipe(Effect.as("ok")),
      FAST,
    );

    expect(value).toBe("ok");
    expect(yield* Ref.get(attempts)).toBe(1);
  }),
);

it.effect("withResilience retries past timeouts then succeeds", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);

    const op = Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(attempts, (x) => x + 1);
      if (n < 3) return yield* Effect.never;
      return "ok";
    });

    const fiber = yield* Effect.fork(withResilience("test.retry.success", op, FAST));
    yield* TestClock.adjust(Duration.seconds(30));

    const exit = Option.getOrThrow(yield* Fiber.poll(fiber));
    expect(Exit.isSuccess(exit) && exit.value).toBe("ok");
    expect(yield* Ref.get(attempts)).toBe(3);
  }),
);

it.effect("withResilience retries up to maxRetries then dies", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);

    const op = Ref.update(attempts, (n) => n + 1).pipe(Effect.zipRight(Effect.never));

    const fiber = yield* Effect.fork(withResilience("test.retry.cap", op, FAST));
    yield* TestClock.adjust(Duration.seconds(30));

    const exit = Option.getOrThrow(yield* Fiber.poll(fiber));
    expect(Exit.isFailure(exit) && Option.isSome(Cause.dieOption(exit.cause))).toBe(true);
    // first attempt + maxRetries
    expect(yield* Ref.get(attempts)).toBe(4);
  }),
);

it.effect("withResilience does not retry a typed business error by default", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);

    const op = Ref.update(attempts, (n) => n + 1).pipe(
      Effect.zipRight(Effect.fail(new FlakyError({ reason: "nope" }))),
    );

    const exit = yield* withResilience("test.no-retry", op, FAST).pipe(Effect.exit);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(yield* Ref.get(attempts)).toBe(1);
  }),
);

it.effect("withResilience retries a typed error when isRetryable allows it", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);

    const op = Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(attempts, (x) => x + 1);
      if (n < 3) return yield* Effect.fail(new FlakyError({ reason: "transient" }));
      return "ok";
    });

    const fiber = yield* Effect.fork(
      withResilience("test.retry.typed", op, { ...FAST, isRetryable: () => true }),
    );
    yield* TestClock.adjust(Duration.seconds(30));

    const exit = Option.getOrThrow(yield* Fiber.poll(fiber));
    expect(Exit.isSuccess(exit) && exit.value).toBe("ok");
    expect(yield* Ref.get(attempts)).toBe(3);
  }),
);

it.effect("withTimeout passes a fast success through unchanged", () =>
  Effect.gen(function* () {
    const value = yield* withTimeout("test.timeout.pass", Effect.succeed(42));

    expect(value).toBe(42);
  }),
);

it.effect("counts retries and timeouts as operation-tagged metrics", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);

    const op = Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(attempts, (x) => x + 1);
      if (n < 3) return yield* Effect.never;
      return "ok";
    });

    const fiber = yield* Effect.fork(withResilience("test.metrics", op, FAST));
    yield* TestClock.adjust(Duration.seconds(30));
    yield* Fiber.join(fiber);

    const retries = yield* Metric.value(Metric.tagged(ioRetriesTotal, "operation", "test.metrics"));
    const timeouts = yield* Metric.value(
      Metric.tagged(ioTimeoutsTotal, "operation", "test.metrics"),
    );
    expect(retries.count).toBe(2);
    expect(timeouts.count).toBe(2);
  }),
);

it.effect("annotates retry.count and timed_out on the operation span", () =>
  Effect.gen(function* () {
    const spanRef = yield* Ref.make<Tracer.AnySpan | undefined>(undefined);
    const attempts = yield* Ref.make(0);

    const op = Effect.gen(function* () {
      yield* Effect.currentSpan.pipe(Effect.flatMap((span) => Ref.set(spanRef, span)));
      const n = yield* Ref.updateAndGet(attempts, (x) => x + 1);
      if (n < 2) return yield* Effect.never;
      return "ok";
    });

    const fiber = yield* Effect.fork(withResilience("test.span", op, FAST));
    yield* TestClock.adjust(Duration.seconds(30));
    yield* Fiber.join(fiber);

    const span = yield* Ref.get(spanRef);
    const attributes = (span as { attributes: ReadonlyMap<string, unknown> } | undefined)
      ?.attributes;
    expect(attributes?.get("retry.count")).toBe(1);
    expect(attributes?.get("timed_out")).toBe(true);
  }),
);
