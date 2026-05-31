import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Layer, Logger, ManagedRuntime } from "effect";

import { globalContextManagerLayer } from "@tix/observability/otel-context";
import { otlpLayer } from "@tix/observability/otel-layer";

import type { ExpirationEnv } from "./config.ts";
import {
  Database,
  DatabaseLayer,
  EventPublisher,
  EventPublisherLayer,
  ExpirationConfig,
  makeExpirationConfigLayer,
  Nats,
  NatsLayer,
  Scheduler,
  SchedulerLayer,
} from "./services.ts";

// Every service the expiration runtime exposes. The consumer and worker program
// against this `R` channel.
export type ExpirationServices = ExpirationConfig | Database | Nats | EventPublisher | Scheduler;

export type ExpirationRuntime = ManagedRuntime.ManagedRuntime<ExpirationServices, never>;

// Traces, logs, and metrics export over OTLP with the service name hard-set to "expiration"
// (the endpoint still comes from env, defaulting to the in-cluster collector). Hard-setting
// the name — rather than reading OTEL_SERVICE_NAME via makeOtelLayer — keeps the error
// channel `never`, so booting never depends on that env var being present.
//
// `globalContextManagerLayer` installs the async context manager that lets the OTLP tracer's
// span bridge reach the trace-context capture on the enqueued job (see trace-job.ts).
// `Logger.pretty` is local-dev console only; OTLP log export lives inside `otlpLayer`.
function makeObservabilityLayer(env: ExpirationEnv): Layer.Layer<never> {
  return Layer.mergeAll(
    otlpLayer({ serviceName: "expiration", baseUrl: env.otelEndpoint }).pipe(
      Layer.provide(FetchHttpClient.layer),
    ),
    globalContextManagerLayer,
    Logger.pretty,
  );
}

// Assembles the full Layer graph: config feeds the resource layers; the single Nats
// connection feeds the publisher; observability is merged in. `provideMerge` keeps every
// provided service in the output so the runtime exposes them all while wiring shared
// dependencies exactly once.
export function makeExpirationLayer(env: ExpirationEnv): Layer.Layer<ExpirationServices> {
  const configLayer = makeExpirationConfigLayer(env);

  const resources = Layer.mergeAll(DatabaseLayer, NatsLayer, SchedulerLayer);

  const services = EventPublisherLayer.pipe(
    Layer.provideMerge(resources),
    Layer.provideMerge(configLayer),
  );

  return Layer.merge(services, makeObservabilityLayer(env));
}

export function makeExpirationRuntime(env: ExpirationEnv): ExpirationRuntime {
  return ManagedRuntime.make(makeExpirationLayer(env));
}
