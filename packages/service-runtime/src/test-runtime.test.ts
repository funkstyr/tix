import { Context, Effect, Layer } from "effect";
import { expect, it } from "vitest";

import {
  makeServiceTestRuntime,
  throwingAuthClient,
  throwingNats,
  throwingPublisher,
} from "./test-runtime.ts";

it("stubs throw on access", () => {
  expect(() => throwingNats().closed).toThrow("Nats not provided to test runtime");
  expect(() => throwingPublisher().publish("s", {})).toThrow(
    "EventPublisher not provided to test runtime",
  );
  expect(() => throwingAuthClient().getSession({} as never)).toThrow(
    "AuthClient not provided to test runtime",
  );
});

class Probe extends Context.Tag("service-runtime-test/Probe2")<Probe, number>() {}

it("makeServiceTestRuntime runs the appLayer with no OTLP", async () => {
  const runtime = makeServiceTestRuntime(Layer.succeed(Probe, 7));
  try {
    expect(await runtime.runPromise(Effect.map(Probe, (n) => n + 1))).toBe(8);
  } finally {
    await runtime.dispose();
  }
});
