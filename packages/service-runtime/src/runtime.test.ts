import { Context, Layer } from "effect";
import { expect, it } from "vitest";

import { makeServiceRuntime } from "./runtime.ts";

class Probe extends Context.Tag("service-runtime-test/Probe")<Probe, number>() {}

// Building + disposing the real OpenTelemetry SDK runtime takes a few seconds;
// the default 5s vitest timeout leaves no headroom and flakes on a saturated CI
// box (the OTLP/observability suites run concurrently). Give it room.
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
}, 20_000);
