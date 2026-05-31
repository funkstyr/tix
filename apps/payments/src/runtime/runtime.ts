import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Layer, Logger, ManagedRuntime } from "effect";

import { globalContextManagerLayer } from "@tix/observability/otel-context";
import { otlpLayer } from "@tix/observability/otel-layer";

import type { PaymentsEnv } from "./config.ts";
import {
  AuthClient,
  AuthClientLayer,
  Database,
  DatabaseLayer,
  EventPublisher,
  EventPublisherLayer,
  makePaymentsConfigLayer,
  Nats,
  NatsLayer,
  PaymentIntents,
  PaymentIntentsLayer,
  PaymentsConfig,
} from "./services.ts";

// Every service the payments runtime exposes. Handlers, consumers, and the relay
// program against this `R` channel.
export type PaymentsServices =
  | PaymentsConfig
  | Database
  | Nats
  | EventPublisher
  | AuthClient
  | PaymentIntents;

export type PaymentsRuntime = ManagedRuntime.ManagedRuntime<PaymentsServices, never>;

// Traces, logs, and metrics export over OTLP with the service name hard-set to "payments"
// (the endpoint still comes from env, defaulting to the in-cluster collector). Hard-setting
// the name — rather than reading OTEL_SERVICE_NAME via makeOtelLayer — keeps the error
// channel `never`, so booting never depends on that env var being present.
//
// `globalContextManagerLayer` installs the async context manager that lets the OTLP tracer's
// span bridge reach the outbox / NATS / outbound-HTTP propagation paths (see otel-context.ts).
// `Logger.pretty` is local-dev console only; OTLP log export lives inside `otlpLayer`.
function makeObservabilityLayer(env: PaymentsEnv): Layer.Layer<never> {
  return Layer.mergeAll(
    otlpLayer({ serviceName: "payments", baseUrl: env.otelEndpoint }).pipe(
      Layer.provide(FetchHttpClient.layer),
    ),
    globalContextManagerLayer,
    Logger.pretty,
  );
}

// Assembles the full Layer graph: config feeds the resource layers; the single
// Nats connection feeds the publisher; observability is merged in. `provideMerge`
// keeps every provided service in the output so the runtime exposes them all while
// wiring shared dependencies exactly once.
export function makePaymentsLayer(env: PaymentsEnv): Layer.Layer<PaymentsServices> {
  const configLayer = makePaymentsConfigLayer(env);

  const resources = Layer.mergeAll(DatabaseLayer, NatsLayer, AuthClientLayer, PaymentIntentsLayer);

  const services = EventPublisherLayer.pipe(
    Layer.provideMerge(resources),
    Layer.provideMerge(configLayer),
  );

  return Layer.merge(services, makeObservabilityLayer(env));
}

export function makePaymentsRuntime(env: PaymentsEnv): PaymentsRuntime {
  return ManagedRuntime.make(makePaymentsLayer(env));
}
