import { Layer, ManagedRuntime } from "effect";

import { makeObservabilityLayer } from "./layers.js";

// Builds the single per-service ManagedRuntime: the service-composed `appLayer` merged
// with the shared observability layer. Each service composes `appLayer` from the shared
// connection-layer factories plus its own domain layers, so this factory is uniform across
// every service — including gateway (no db/NATS) and expiration (no auth).
export function makeServiceRuntime<R>(opts: {
  serviceName: string;
  otelEndpoint: string;
  appLayer: Layer.Layer<R>;
}): ManagedRuntime.ManagedRuntime<R, never> {
  return ManagedRuntime.make(
    Layer.merge(
      opts.appLayer,
      makeObservabilityLayer({ serviceName: opts.serviceName, otelEndpoint: opts.otelEndpoint }),
    ),
  );
}
