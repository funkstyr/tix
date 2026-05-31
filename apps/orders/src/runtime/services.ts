import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Context, Effect, Layer } from "effect";
import type { Logger } from "pino";

import { type AuthSessionClient, createHttpAuthSessionClient } from "@tix/contracts/auth-client";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher, type Publisher } from "@tix/messaging/jetstream";
import { createLogger } from "@tix/observability/logger";

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

// Pino logger for the wire/infra adapters (publisher, outbox relay, JetStream
// consumer loop) that still take a pino `Logger`. Orders' own business logic logs
// through Effect; pino removal is ADR-0008's final cleanup slice.
export class InfraLogger extends Context.Tag("orders/InfraLogger")<InfraLogger, Logger>() {}

export function makeOrdersConfigLayer(env: OrdersEnv): Layer.Layer<OrdersConfig> {
  return Layer.succeed(OrdersConfig, env);
}

export const InfraLoggerLayer: Layer.Layer<InfraLogger, never, OrdersConfig> = Layer.effect(
  InfraLogger,
  Effect.map(OrdersConfig, (env) => createLogger({ name: "orders", level: env.logLevel })),
);

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

export const EventPublisherLayer: Layer.Layer<EventPublisher, never, Nats | InfraLogger> =
  Layer.effect(
    EventPublisher,
    Effect.gen(function* () {
      const nats = yield* Nats;
      const logger = yield* InfraLogger;

      return createPublisher(nats, { logger });
    }),
  );

export const AuthClientLayer: Layer.Layer<AuthClient, never, OrdersConfig> = Layer.effect(
  AuthClient,
  Effect.map(OrdersConfig, (env) => createHttpAuthSessionClient(env.authBaseUrl)),
);

export const TicketsLayer: Layer.Layer<Tickets, never, OrdersConfig> = Layer.effect(
  Tickets,
  Effect.map(OrdersConfig, (env) =>
    createHttpTicketsClient(env.ticketsBaseUrl, env.ticketsServiceToken),
  ),
);
