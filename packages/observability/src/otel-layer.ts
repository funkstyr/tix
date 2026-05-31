import * as Otlp from "@effect/opentelemetry/Otlp";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import type * as HttpClient from "@effect/platform/HttpClient";
import { Effect, Layer, Logger } from "effect";
import type * as ConfigError from "effect/ConfigError";

import { type OtelConfig, otelConfig } from "./otel-config.js";
import { bridgeOtelContext } from "./otel-context.js";

export function otlpLayer(config: OtelConfig): Layer.Layer<never, never, HttpClient.HttpClient> {
  return Otlp.layerJson({
    baseUrl: config.baseUrl,
    resource: { serviceName: config.serviceName },
    // Mirror each Effect span into the global OTel context so the outbox / NATS / outbound
    // HTTP propagation paths can read it (see otel-context.ts).
    tracerContext: bridgeOtelContext,
  });
}

export function makeOtelLayer(): Layer.Layer<never, ConfigError.ConfigError> {
  return Layer.unwrapEffect(
    Effect.map(otelConfig, (config) =>
      Layer.merge(otlpLayer(config).pipe(Layer.provide(FetchHttpClient.layer)), Logger.pretty),
    ),
  );
}
