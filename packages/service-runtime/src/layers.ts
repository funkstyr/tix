import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { connect } from "@nats-io/transport-node";
import { type Context, Effect, Layer, Logger } from "effect";

import { createHttpAuthSessionClient } from "@tix/contracts/auth-client";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher } from "@tix/messaging/jetstream";
import { globalContextManagerLayer } from "@tix/observability/otel-context";
import { traceparentHeaders } from "@tix/observability/otel-http";
import { otlpLayer } from "@tix/observability/otel-layer";
import { withResilience } from "@tix/observability/resilience";

import { AuthClient, EventPublisher, Nats } from "./tags.js";

// Generic over the per-service `Database` tag so each service keeps its typed
// `DbClient<typeof xxxTables>`. The db client connects lazily, so acquisition is
// synchronous; release drains the pool (LIFO at scope finalization).
export function makeDatabaseLayer<Self, Tables extends Record<string, unknown>>(
  tag: Context.Tag<Self, DbClient<Tables>>,
  opts: { schemaName: string; databaseUrl: string; schema: Tables },
): Layer.Layer<Self> {
  return Layer.scoped(
    tag,
    Effect.acquireRelease(
      Effect.sync(() => createDbClient(opts.schemaName, opts.databaseUrl, { schema: opts.schema })),
      (client) => Effect.promise(() => client.close()),
    ),
  );
}

// NATS connection with retry on connect (withResilience) and close on scope finalization.
export function makeNatsLayer(opts: { serviceName: string; natsUrl: string }): Layer.Layer<Nats> {
  return Layer.scoped(
    Nats,
    Effect.acquireRelease(
      withResilience(
        `${opts.serviceName}.nats.connect`,
        Effect.tryPromise({
          try: () => connect({ servers: opts.natsUrl }),
          catch: (error) => error,
        }),
        { isRetryable: () => true },
      ).pipe(Effect.orDie),
      (nats) => Effect.promise(() => nats.close()),
    ),
  );
}

// The publisher takes no logger (ADR-0009): messaging routes failures through Effect's
// Logger, and trace context rides on NATS headers the relay injects, not this layer.
export const eventPublisherLayer: Layer.Layer<EventPublisher, never, Nats> = Layer.effect(
  EventPublisher,
  Effect.map(Nats, (nats) => createPublisher(nats)),
);

// `traceparentHeaders` reads the active span (live via the OTel context bridge) on every
// call, so outbound auth requests carry W3C `traceparent` to continue the trace.
export function makeAuthClientLayer(opts: { authBaseUrl: string }): Layer.Layer<AuthClient> {
  return Layer.effect(
    AuthClient,
    Effect.sync(() =>
      createHttpAuthSessionClient(opts.authBaseUrl, { headers: traceparentHeaders }),
    ),
  );
}

// Traces, logs, and metrics export over OTLP with the service name hard-set (the endpoint
// comes from env). Hard-setting the name keeps the error channel `never`, so booting never
// depends on an env var. `globalContextManagerLayer` installs the async context manager that
// lets the OTLP tracer's span bridge reach the outbox / NATS / outbound-HTTP propagation
// paths. `Logger.pretty` is local-dev console only; OTLP log export lives inside `otlpLayer`.
export function makeObservabilityLayer(opts: {
  serviceName: string;
  otelEndpoint: string;
}): Layer.Layer<never> {
  return Layer.mergeAll(
    otlpLayer({ serviceName: opts.serviceName, baseUrl: opts.otelEndpoint }).pipe(
      Layer.provide(FetchHttpClient.layer),
    ),
    globalContextManagerLayer,
    Logger.pretty,
  );
}
