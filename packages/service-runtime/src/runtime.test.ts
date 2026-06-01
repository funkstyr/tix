import { Context, Layer } from "effect";
import { expect, it } from "vitest";

import { makeServiceRuntime } from "./runtime.ts";

class Probe extends Context.Tag("service-runtime-test/Probe")<Probe, number>() {}

it("exposes the appLayer's services and merges observability without error", async () => {
  const runtime = makeServiceRuntime({
    serviceName: "test",
    otelEndpoint: "http://otel.test:4318",
    appLayer: Layer.succeed(Probe, 42),
  });

  try {
    const value = await runtime.runPromise(Probe);
    expect(value).toBe(42);
  } finally {
    await runtime.dispose();
  }
});
