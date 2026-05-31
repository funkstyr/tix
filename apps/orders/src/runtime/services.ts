import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Context, Effect, Layer } from "effect";

import { type AuthSessionClient, createHttpAuthSessionClient } from "@tix/contracts/auth-client";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher, type Publisher } from "@tix/messaging/jetstream";
import { traceparentHeaders } from "@tix/observability/otel-http";

import { ordersTables } from "../domain/schema.ts";
import { createHttpTicketsClient, type TicketsClient } from "../tickets-client.ts";
import type { OrdersEnv } from "./config.ts";

export type OrdersDb = DbClient<typeof ordersTables>;

// Service tags. Together these replace the hand-injected `deps` object — the
// router, consumers, and relay resolve them from the runtime's Layer graph
// instead of receiving them as constructor arguments (ADR-0008).
export class OrdersConfig extends Context.Tag("orders/OrdersConfig")<OrdersConfig, OrdersEnv>() {}

export class Database extends Context.Tag("orders/Database")<Database, OrdersDb>() {}

export class Nats extends Context.Tag("orders/Nats")<Nats, NatsConnection>() {}

export class EventPublisher extends Context.Tag("orders/EventPublisher")<
  EventPublisher,
  Publisher
>() {}

export class AuthClient extends Context.Tag("orders/AuthClient")<AuthClient, AuthSessionClient>() {}

export class Tickets extends Context.Tag("orders/Tickets")<Tickets, TicketsClient>() {}

export function makeOrdersConfigLayer(env: OrdersEnv): Layer.Layer<OrdersConfig> {
  return Layer.succeed(OrdersConfig, env);
}

// The db client connects lazily, so acquisition is synchronous; release drains
// the pool. Scope finalization tears it down automatically (LIFO) at shutdown.
export const DatabaseLayer: Layer.Layer<Database, never, OrdersConfig> = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const env = yield* OrdersConfig;

    return yield* Effect.acquireRelease(
      Effect.sync(() => createDbClient("orders", env.databaseUrl, { schema: ordersTables })),
      (client) => Effect.promise(() => client.close()),
    );
  }),
);

export const NatsLayer: Layer.Layer<Nats, never, OrdersConfig> = Layer.scoped(
  Nats,
  Effect.gen(function* () {
    const env = yield* OrdersConfig;

    return yield* Effect.acquireRelease(
      Effect.promise(() => connect({ servers: env.natsUrl })),
      (nats) => Effect.promise(() => nats.close()),
    );
  }),
);

// The publisher takes no logger (ADR-0009): domain events are logged by the Effect consumer
// handlers, and the messaging package sends only wire-level failures to `console.error`. Trace
// context rides on NATS headers the relay injects from the stored outbox value, not this layer.
export const EventPublisherLayer: Layer.Layer<EventPublisher, never, Nats> = Layer.effect(
  EventPublisher,
  Effect.map(Nats, (nats) => createPublisher(nats)),
);

// `traceparentHeaders` reads the active span (live thanks to the OTel context bridge) on
// every call, so outbound auth/tickets requests carry W3C `traceparent` to continue the
// trace at the next instrumented service.
export const AuthClientLayer: Layer.Layer<AuthClient, never, OrdersConfig> = Layer.effect(
  AuthClient,
  Effect.map(OrdersConfig, (env) =>
    createHttpAuthSessionClient(env.authBaseUrl, { headers: traceparentHeaders }),
  ),
);

export const TicketsLayer: Layer.Layer<Tickets, never, OrdersConfig> = Layer.effect(
  Tickets,
  Effect.map(OrdersConfig, (env) =>
    createHttpTicketsClient(env.ticketsBaseUrl, env.ticketsServiceToken, {
      headers: traceparentHeaders,
    }),
  ),
);
