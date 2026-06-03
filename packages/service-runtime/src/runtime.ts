import { Layer, ManagedRuntime } from "effect";
import { createRequire } from "node:module";

import { makeObservabilityLayer } from "./layers.js";
import { type PyroscopeLike, startProfiling } from "./profiling.js";

// Builds the single per-service ManagedRuntime: the service-composed `appLayer` merged
// with the shared observability layer. Each service composes `appLayer` from the shared
// connection-layer factories plus its own domain layers, so this factory is uniform across
// every service — including gateway (no db/NATS) and expiration (no auth).
export function makeServiceRuntime<R>(opts: {
  serviceName: string;
  otelEndpoint: string;
  // Deploy/build version for profile correlation. Defaults to SERVICE_VERSION env or "dev".
  version?: string;
  appLayer: Layer.Layer<R>;
}): ManagedRuntime.ManagedRuntime<R, never> {
  // Only load @pyroscope/nodejs (which pulls the native @datadog/pprof addon) when profiling is
  // actually enabled, so disabled processes and the test suite never touch native code.
  if (process.env["PROFILING_ENABLED"] === "true" && process.env["PYROSCOPE_SERVER_ADDRESS"]) {
    const pyroscope = createRequire(import.meta.url)("@pyroscope/nodejs") as PyroscopeLike;
    startProfiling({
      serviceName: opts.serviceName,
      version: opts.version ?? process.env["SERVICE_VERSION"] ?? "dev",
      env: process.env,
      pyroscope,
    });
  }

  return ManagedRuntime.make(
    Layer.merge(
      opts.appLayer,
      makeObservabilityLayer({ serviceName: opts.serviceName, otelEndpoint: opts.otelEndpoint }),
    ),
  );
}
