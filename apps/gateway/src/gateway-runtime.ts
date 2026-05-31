import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Layer, Logger, ManagedRuntime } from "effect";

import { globalContextManagerLayer } from "@tix/observability/otel-context";
import { otlpLayer } from "@tix/observability/otel-layer";

import type { GatewayEnv } from "./gateway-env.ts";
import { Downstream, DownstreamLayer, makeGatewayConfigLayer } from "./gateway-services.ts";

// The only service the runtime exposes: handlers resolve `Downstream`; the config
// is provided internally to build it and isn't surfaced.
export type GatewayServices = Downstream;

export type GatewayRuntime = ManagedRuntime.ManagedRuntime<Downstream, never>;

// Traces, logs, and metrics export over OTLP with the service name hard-set to "gateway"
// (the endpoint comes from env, defaulting to the in-cluster collector). Hard-setting
// the name keeps the error channel `never`, so booting never depends on an env var.
//
// `globalContextManagerLayer` installs the async context manager that lets the OTLP
// tracer's span bridge reach the outbound-HTTP / auth-proxy propagation paths (see
// otel-context.ts). `Logger.pretty` is local-dev console only; OTLP log export lives
// inside `otlpLayer`.
function makeObservabilityLayer(env: GatewayEnv): Layer.Layer<never> {
  return Layer.mergeAll(
    otlpLayer({ serviceName: "gateway", baseUrl: env.otelEndpoint }).pipe(
      Layer.provide(FetchHttpClient.layer),
    ),
    globalContextManagerLayer,
    Logger.pretty,
  );
}

// Config feeds the downstream-client layer; observability is merged in alongside.
export function makeGatewayLayer(env: GatewayEnv): Layer.Layer<Downstream> {
  return Layer.merge(
    DownstreamLayer.pipe(Layer.provide(makeGatewayConfigLayer(env))),
    makeObservabilityLayer(env),
  );
}

export function makeGatewayRuntime(env: GatewayEnv): GatewayRuntime {
  return ManagedRuntime.make(makeGatewayLayer(env));
}
