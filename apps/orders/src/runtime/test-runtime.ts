import type { NatsConnection } from "@nats-io/transport-node";
import { Layer, Logger, ManagedRuntime } from "effect";

import type { AuthSessionClient } from "@tix/contracts/auth-client";
import { createPublisher } from "@tix/messaging/jetstream";
import { createLogger } from "@tix/observability/logger";

import type { TicketsClient } from "../tickets-client.ts";
import type { OrdersEnv } from "./config.ts";
import type { OrdersRuntime } from "./runtime.ts";
import {
  AuthClient,
  Database,
  EventPublisher,
  Nats,
  type OrdersDb,
  OrdersConfig,
  Tickets,
} from "./services.ts";

const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;

export type OrdersTestDeps = {
  db: OrdersDb;
  authClient?: AuthSessionClient;
  ticketsClient?: TicketsClient;
  nats?: NatsConnection;
  reservationTtlMs?: number;
};

// The service Layer (no Clock) for in-process tests that run a program directly
// with `Effect.provide` — leaving the ambient `Clock`/`TestClock` from
// `@effect/vitest` in scope so TTL/expiry assertions are deterministic.
export function createOrdersTestLayer(
  deps: OrdersTestDeps,
): Layer.Layer<OrdersConfig | Database | AuthClient | Tickets | EventPublisher | Nats> {
  const env = makeTestEnv(deps.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS);
  const logger = createLogger({ name: "orders-test", level: "fatal" });
  const nats = deps.nats;

  return Layer.mergeAll(
    Layer.succeed(OrdersConfig, env),
    Layer.succeed(Database, deps.db),
    Layer.succeed(AuthClient, deps.authClient ?? throwingAuthClient()),
    Layer.succeed(Tickets, deps.ticketsClient ?? throwingTicketsClient()),
    Layer.succeed(Nats, nats ?? throwingNats()),
    Layer.succeed(
      EventPublisher,
      nats === undefined ? throwingPublisher() : createPublisher(nats, { logger }),
    ),
  );
}

// Builds a ManagedRuntime from explicit, already-constructed collaborators instead
// of the env-driven resource layers, so in-process tests provide test `Layer`s and
// drive the same Effect programs the router and consumers run in production. OTLP
// is omitted — logs go through Effect's pretty logger.
export function createOrdersTestRuntime(deps: OrdersTestDeps): OrdersRuntime {
  const env = makeTestEnv(deps.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS);
  const logger = createLogger({ name: "orders-test", level: "fatal" });

  const base = Layer.mergeAll(Layer.succeed(OrdersConfig, env), Layer.succeed(Database, deps.db));

  // Auth/Tickets/Nats/Publisher are only needed by the handlers/consumers a given
  // test exercises; provide a throwing stub for any the test omits so an accidental
  // dependency surfaces loudly instead of silently using a half-built runtime.
  const auth = Layer.succeed(AuthClient, deps.authClient ?? throwingAuthClient());
  const tickets = Layer.succeed(Tickets, deps.ticketsClient ?? throwingTicketsClient());

  const nats = deps.nats;
  const natsLayer = Layer.succeed(Nats, nats ?? throwingNats());
  const publisherLayer =
    nats === undefined
      ? Layer.succeed(EventPublisher, throwingPublisher())
      : Layer.succeed(EventPublisher, createPublisher(nats, { logger }));

  return ManagedRuntime.make(
    Layer.mergeAll(base, auth, tickets, natsLayer, publisherLayer, Logger.pretty),
  );
}

function makeTestEnv(reservationTtlMs: number): OrdersEnv {
  return {
    port: 0,
    databaseUrl: "postgres://test",
    authBaseUrl: "http://auth.test",
    ticketsBaseUrl: "http://tickets.test",
    ticketsServiceToken: "test-token",
    natsUrl: "nats://test",
    stream: "ORDERS",
    paymentsStream: "PAYMENTS",
    ticketsStream: "TICKETS",
    reservationTtlMs,
    otelEndpoint: "http://otel.test:4318",
    logLevel: "fatal",
  };
}

function throwingAuthClient(): AuthSessionClient {
  return {
    getSession: () => {
      throw new Error("AuthClient not provided to test runtime");
    },
  };
}

function throwingTicketsClient(): TicketsClient {
  return {
    reserve: () => {
      throw new Error("TicketsClient not provided to test runtime");
    },
    getById: () => {
      throw new Error("TicketsClient not provided to test runtime");
    },
  };
}

function throwingNats(): NatsConnection {
  return new Proxy({} as NatsConnection, {
    get() {
      throw new Error("Nats not provided to test runtime");
    },
  });
}

function throwingPublisher(): ReturnType<typeof createPublisher> {
  return {
    publish: () => {
      throw new Error("EventPublisher not provided to test runtime");
    },
  };
}
