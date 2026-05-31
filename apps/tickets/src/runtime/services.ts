import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Context, Effect, Layer } from "effect";

import { type AuthSessionClient, createHttpAuthSessionClient } from "@tix/contracts/auth-client";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher, type Publisher } from "@tix/messaging/jetstream";
import { traceparentHeaders } from "@tix/observability/otel-http";

import { ticketsTables } from "../domain/schema.ts";
import type { TicketsEnv } from "./config.ts";

export type TicketsDb = DbClient<typeof ticketsTables>;

// Service tags. Together these replace the hand-injected `deps` object — the router,
// consumer, and relay resolve them from the runtime's Layer graph instead of receiving
// them as constructor arguments (ADR-0008). Unlike orders, tickets calls no peer service,
// so there is no outbound oRPC client tag here.
export class TicketsConfig extends Context.Tag("tickets/TicketsConfig")<
  TicketsConfig,
  TicketsEnv
>() {}

export class Database extends Context.Tag("tickets/Database")<Database, TicketsDb>() {}

export class Nats extends Context.Tag("tickets/Nats")<Nats, NatsConnection>() {}

export class EventPublisher extends Context.Tag("tickets/EventPublisher")<
  EventPublisher,
  Publisher
>() {}

export class AuthClient extends Context.Tag("tickets/AuthClient")<
  AuthClient,
  AuthSessionClient
>() {}

export function makeTicketsConfigLayer(env: TicketsEnv): Layer.Layer<TicketsConfig> {
  return Layer.succeed(TicketsConfig, env);
}

// The db client connects lazily, so acquisition is synchronous; release drains the pool.
// Scope finalization tears it down automatically (LIFO) at shutdown.
export const DatabaseLayer: Layer.Layer<Database, never, TicketsConfig> = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const env = yield* TicketsConfig;

    return yield* Effect.acquireRelease(
      Effect.sync(() => createDbClient("tickets", env.databaseUrl, { schema: ticketsTables })),
      (client) => Effect.promise(() => client.close()),
    );
  }),
);

export const NatsLayer: Layer.Layer<Nats, never, TicketsConfig> = Layer.scoped(
  Nats,
  Effect.gen(function* () {
    const env = yield* TicketsConfig;

    return yield* Effect.acquireRelease(
      Effect.promise(() => connect({ servers: env.natsUrl })),
      (nats) => Effect.promise(() => nats.close()),
    );
  }),
);

// The publisher's wire-level logging falls back to the messaging package's internal logger;
// tickets threads no pino logger (ADR-0009). Trace context rides on NATS headers the relay
// injects from the stored outbox value, not from this layer.
export const EventPublisherLayer: Layer.Layer<EventPublisher, never, Nats> = Layer.effect(
  EventPublisher,
  Effect.map(Nats, (nats) => createPublisher(nats)),
);

// `traceparentHeaders` reads the active span (live thanks to the OTel context bridge) on every
// call, so outbound auth requests carry W3C `traceparent` to continue the trace at the auth
// service.
export const AuthClientLayer: Layer.Layer<AuthClient, never, TicketsConfig> = Layer.effect(
  AuthClient,
  Effect.map(TicketsConfig, (env) =>
    createHttpAuthSessionClient(env.authBaseUrl, { headers: traceparentHeaders }),
  ),
);
