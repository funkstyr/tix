import * as Otlp from "@effect/opentelemetry/Otlp";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import type * as HttpClient from "@effect/platform/HttpClient";
import { Effect, Layer, Logger } from "effect";
import type * as ConfigError from "effect/ConfigError";

import { type OtelConfig, otelConfig } from "./otel-config.js";
import { bridgeOtelContext } from "./otel-context.js";
import { awaitCollector, readinessTimeoutFromEnv } from "./otel-readiness.js";

export function otlpLayer(config: OtelConfig): Layer.Layer<never, never, HttpClient.HttpClient> {
  const base = Otlp.layerJson({
    baseUrl: config.baseUrl,
    resource: { serviceName: config.serviceName },
    // Mirror each Effect span into the global OTel context so the outbox / NATS / outbound
    // HTTP propagation paths can read it (see otel-context.ts).
    tracerContext: bridgeOtelContext,
  });

  const readyTimeout = readinessTimeoutFromEnv(process.env["OTEL_COLLECTOR_READY_TIMEOUT_MS"]);

  // Opt-in readiness gate: when a budget is configured (deployments set the env), block the
  // exporter's first flush until the collector is reachable so it can't trip the 60s self-disable
  // and silently drop a quiet service's only logs (see otel-readiness.ts). `Layer.unwrapEffect`
  // runs `awaitCollector` to completion before building `Otlp.layerJson`, whose export fiber forks
  // at build time. Unset → build immediately, so tests and un-opted consumers never wait on the net.
  return readyTimeout === undefined
    ? base
    : Layer.unwrapEffect(
        Effect.as(awaitCollector(config.baseUrl, { timeout: readyTimeout }), base),
      );
}

export function makeOtelLayer(): Layer.Layer<never, ConfigError.ConfigError> {
  return Layer.unwrapEffect(
    Effect.map(otelConfig, (config) =>
      Layer.merge(otlpLayer(config).pipe(Layer.provide(FetchHttpClient.layer)), Logger.pretty),
    ),
  );
}
