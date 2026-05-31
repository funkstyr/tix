import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Layer, Logger, ManagedRuntime } from "effect";

import { globalContextManagerLayer } from "@tix/observability/otel-context";
import { otlpLayer } from "@tix/observability/otel-layer";

import type { TicketsEnv } from "./config.ts";
import {
  AuthClient,
  AuthClientLayer,
  Database,
  DatabaseLayer,
  EventPublisher,
  EventPublisherLayer,
  Nats,
  NatsLayer,
  makeTicketsConfigLayer,
  TicketsConfig,
} from "./services.ts";

// Every service the tickets runtime exposes. The router, consumer, and relay program
// against this `R` channel.
export type TicketsServices = TicketsConfig | Database | Nats | EventPublisher | AuthClient;

export type TicketsRuntime = ManagedRuntime.ManagedRuntime<TicketsServices, never>;

// Traces, logs, and metrics export over OTLP with the service name hard-set to "tickets"
// (the endpoint still comes from env, defaulting to the in-cluster collector). Hard-setting
// the name keeps the error channel `never`, so booting never depends on OTEL_SERVICE_NAME.
//
// `globalContextManagerLayer` installs the async context manager that lets the OTLP tracer's
// span bridge reach the outbox / NATS / outbound-HTTP propagation paths (see otel-context.ts).
// `Logger.pretty` is local-dev console only; OTLP log export lives inside `otlpLayer`.
function makeObservabilityLayer(env: TicketsEnv): Layer.Layer<never> {
  return Layer.mergeAll(
    otlpLayer({ serviceName: "tickets", baseUrl: env.otelEndpoint }).pipe(
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
export function makeTicketsLayer(env: TicketsEnv): Layer.Layer<TicketsServices> {
  const configLayer = makeTicketsConfigLayer(env);

  const resources = Layer.mergeAll(DatabaseLayer, NatsLayer, AuthClientLayer);

  const services = EventPublisherLayer.pipe(
    Layer.provideMerge(resources),
    Layer.provideMerge(configLayer),
  );

  return Layer.merge(services, makeObservabilityLayer(env));
}

export function makeTicketsRuntime(env: TicketsEnv): TicketsRuntime {
  return ManagedRuntime.make(makeTicketsLayer(env));
}
