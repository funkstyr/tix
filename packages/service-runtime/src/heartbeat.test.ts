import { Duration, Effect, Layer, Logger, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { heartbeatLayer } from "./heartbeat.js";

describe("heartbeatLayer", () => {
  it("delays the first beat one interval, then beats every interval", async () => {
    const logs: Array<string> = [];

    const captureLogger = Logger.make(({ message }) => {
      logs.push(String(message));
    });

    const beats = () => logs.filter((m) => m.includes("heartbeat")).length;

    const program = Effect.gen(function* () {
      yield* Layer.build(heartbeatLayer({ serviceName: "svc", interval: Duration.seconds(10) }));

      yield* TestClock.adjust(Duration.seconds(9));
      expect(beats()).toBe(0);

      yield* TestClock.adjust(Duration.seconds(2));
      expect(beats()).toBe(1);

      yield* TestClock.adjust(Duration.seconds(10));
      expect(beats()).toBe(2);
    });

    await Effect.runPromise(
      program.pipe(
        Effect.scoped,
        Effect.provide(Logger.replace(Logger.defaultLogger, captureLogger)),
        Effect.provide(TestContext.TestContext),
      ),
    );
  });

  it("routes beats to a sibling logger layer it is provided (the makeObservabilityLayer shape)", async () => {
    const logs: Array<string> = [];

    const loggerLayer = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message }) => {
        logs.push(String(message));
      }),
    );

    // Mirror makeObservabilityLayer: the logger is a *sibling* layer, and the heartbeat is provided
    // it so its forked fiber inherits the logger instead of snapshotting Effect's default. Without
    // the `Layer.provide`, the beats would race the logger's setup and miss the OTLP/pretty sink.
    const composed = Layer.mergeAll(
      loggerLayer,
      heartbeatLayer({ serviceName: "svc", interval: Duration.seconds(10) }).pipe(
        Layer.provide(loggerLayer),
      ),
    );

    const program = Effect.gen(function* () {
      yield* Layer.build(composed);

      yield* TestClock.adjust(Duration.seconds(11));
      expect(logs.filter((m) => m.includes("heartbeat")).length).toBe(1);
    });

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)));
  });
});
