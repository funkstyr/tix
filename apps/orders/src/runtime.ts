import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Layer, Logger, ManagedRuntime } from "effect";

import { otlpLayer } from "@tix/observability/otel-layer";

import type { OrdersEnv } from "./config.ts";
import {
  AuthClient,
  AuthClientLayer,
  Database,
  DatabaseLayer,
  EventPublisher,
  EventPublisherLayer,
  InfraLogger,
  InfraLoggerLayer,
  Nats,
  NatsLayer,
  makeOrdersConfigLayer,
  OrdersConfig,
  Tickets,
  TicketsLayer,
} from "./services.ts";

// Every service the orders runtime exposes. Handlers, consumers, and the relay
// program against this `R` channel.
export type OrdersServices =
  | OrdersConfig
  | Database
  | Nats
  | EventPublisher
  | AuthClient
  | Tickets
  | InfraLogger;

export type OrdersRuntime = ManagedRuntime.ManagedRuntime<OrdersServices, never>;

// Logs export over OTLP with the service name hard-set to "orders" (the endpoint
// still comes from env, defaulting to the in-cluster collector). Hard-setting the
// name — rather than reading OTEL_SERVICE_NAME via makeOtelLayer — keeps the error
// channel `never`, so booting never depends on that env var being present.
function makeObservabilityLayer(env: OrdersEnv): Layer.Layer<never> {
  return Layer.merge(
    otlpLayer({ serviceName: "orders", baseUrl: env.otelEndpoint }).pipe(
      Layer.provide(FetchHttpClient.layer),
    ),
    Logger.pretty,
  );
}

// Assembles the full Layer graph: config feeds the resource layers; the single
// Nats connection and infra logger feed the publisher; observability is merged
// in. `provideMerge` keeps every provided service in the output so the runtime
// exposes them all while wiring shared dependencies exactly once.
export function makeOrdersLayer(env: OrdersEnv): Layer.Layer<OrdersServices> {
  const configLayer = makeOrdersConfigLayer(env);

  const resources = Layer.mergeAll(
    DatabaseLayer,
    NatsLayer,
    InfraLoggerLayer,
    AuthClientLayer,
    TicketsLayer,
  );

  const services = EventPublisherLayer.pipe(
    Layer.provideMerge(resources),
    Layer.provideMerge(configLayer),
  );

  return Layer.merge(services, makeObservabilityLayer(env));
}

export function makeOrdersRuntime(env: OrdersEnv): OrdersRuntime {
  return ManagedRuntime.make(makeOrdersLayer(env));
}
