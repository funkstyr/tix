import type { NatsConnection } from "@nats-io/transport-node";
import { Layer, Logger, ManagedRuntime } from "effect";

import type { AuthSessionClient } from "@tix/contracts/auth-client";
import { createPublisher } from "@tix/messaging/jetstream";

import type { TicketsEnv } from "./config.ts";
import type { TicketsRuntime } from "./runtime.ts";
import {
  AuthClient,
  Database,
  EventPublisher,
  Nats,
  type TicketsDb,
  TicketsConfig,
} from "./services.ts";

export type TicketsTestDeps = {
  db: TicketsDb;
  authClient?: AuthSessionClient;
  nats?: NatsConnection;
  serviceToken?: string;
};

// The service Layer (no Clock) for in-process tests that run a program directly with
// `Effect.provide` — leaving the ambient `Clock`/`TestClock` from `@effect/vitest` in scope.
export function createTicketsTestLayer(
  deps: TicketsTestDeps,
): Layer.Layer<TicketsConfig | Database | AuthClient | EventPublisher | Nats> {
  const env = makeTestEnv(deps.serviceToken);
  const nats = deps.nats;

  return Layer.mergeAll(
    Layer.succeed(TicketsConfig, env),
    Layer.succeed(Database, deps.db),
    Layer.succeed(AuthClient, deps.authClient ?? throwingAuthClient()),
    Layer.succeed(Nats, nats ?? throwingNats()),
    Layer.succeed(EventPublisher, nats === undefined ? throwingPublisher() : createPublisher(nats)),
  );
}

// Builds a ManagedRuntime from explicit, already-constructed collaborators instead of the
// env-driven resource layers, so in-process tests provide test `Layer`s and drive the same
// Effect programs the router and consumer run in production. OTLP is omitted — logs go
// through Effect's pretty logger.
export function createTicketsTestRuntime(deps: TicketsTestDeps): TicketsRuntime {
  const env = makeTestEnv(deps.serviceToken);

  const base = Layer.mergeAll(Layer.succeed(TicketsConfig, env), Layer.succeed(Database, deps.db));

  // Auth/Nats/Publisher are only needed by the handlers/consumer a given test exercises;
  // provide a throwing stub for any the test omits so an accidental dependency surfaces
  // loudly instead of silently using a half-built runtime.
  const auth = Layer.succeed(AuthClient, deps.authClient ?? throwingAuthClient());

  const nats = deps.nats;
  const natsLayer = Layer.succeed(Nats, nats ?? throwingNats());
  const publisherLayer =
    nats === undefined
      ? Layer.succeed(EventPublisher, throwingPublisher())
      : Layer.succeed(EventPublisher, createPublisher(nats));

  return ManagedRuntime.make(Layer.mergeAll(base, auth, natsLayer, publisherLayer, Logger.pretty));
}

const TEST_SERVICE_TOKEN = "test-token";

function makeTestEnv(serviceToken: string | undefined): TicketsEnv {
  return {
    port: 0,
    databaseUrl: "postgres://test",
    authBaseUrl: "http://auth.test",
    natsUrl: "nats://test",
    serviceToken: serviceToken ?? TEST_SERVICE_TOKEN,
    ordersStream: "ORDERS",
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
