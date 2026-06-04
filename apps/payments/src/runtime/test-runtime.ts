import type { NatsConnection } from "@nats-io/transport-node";
import { Layer } from "effect";

import type { AuthSessionClient } from "@tix/contracts/auth-client";
import { createPublisher } from "@tix/messaging/jetstream";
import {
  makeServiceTestRuntime,
  throwingAuthClient,
  throwingNats,
  throwingPublisher,
} from "@tix/service-runtime/test";

import type { PaymentIntentClient } from "../stripe-payment-intent.ts";
import type { PaymentsEnv } from "./config.ts";
import type { PaymentsRuntime } from "./runtime.ts";
import {
  AuthClient,
  Database,
  EventPublisher,
  Nats,
  PaymentIntents,
  type PaymentsDb,
  PaymentsConfig,
} from "./services.ts";

export type PaymentsTestDeps = {
  db: PaymentsDb;
  authClient?: AuthSessionClient;
  paymentIntentClient?: PaymentIntentClient;
  nats?: NatsConnection;
};

// The service Layer for in-process tests that run a program directly with
// `Effect.provide` — leaving the ambient `Clock`/`TestClock` from `@effect/vitest`
// in scope so time-based assertions stay deterministic.
export function createPaymentsTestLayer(
  deps: PaymentsTestDeps,
): Layer.Layer<PaymentsConfig | Database | AuthClient | PaymentIntents | EventPublisher | Nats> {
  const nats = deps.nats;

  return Layer.mergeAll(
    Layer.succeed(PaymentsConfig, makeTestEnv()),
    Layer.succeed(Database, deps.db),
    Layer.succeed(AuthClient, deps.authClient ?? throwingAuthClient()),
    Layer.succeed(PaymentIntents, deps.paymentIntentClient ?? throwingPaymentIntents()),
    Layer.succeed(Nats, nats ?? throwingNats()),
    Layer.succeed(EventPublisher, nats === undefined ? throwingPublisher() : createPublisher(nats)),
  );
}

// Builds a ManagedRuntime from explicit, already-constructed collaborators instead
// of the env-driven resource layers, so in-process tests provide test `Layer`s and
// drive the same Effect programs the router and consumers run in production. OTLP
// is omitted — logs go through Effect's pretty logger.
export function createPaymentsTestRuntime(deps: PaymentsTestDeps): PaymentsRuntime {
  const base = Layer.mergeAll(
    Layer.succeed(PaymentsConfig, makeTestEnv()),
    Layer.succeed(Database, deps.db),
  );

  // Auth/PaymentIntents/Nats/Publisher are only needed by the handlers/consumers a
  // given test exercises; provide a throwing stub for any the test omits so an
  // accidental dependency surfaces loudly instead of silently using a half-built runtime.
  const auth = Layer.succeed(AuthClient, deps.authClient ?? throwingAuthClient());
  const paymentIntents = Layer.succeed(
    PaymentIntents,
    deps.paymentIntentClient ?? throwingPaymentIntents(),
  );

  const nats = deps.nats;
  const natsLayer = Layer.succeed(Nats, nats ?? throwingNats());
  const publisherLayer =
    nats === undefined
      ? Layer.succeed(EventPublisher, throwingPublisher())
      : Layer.succeed(EventPublisher, createPublisher(nats));

  return makeServiceTestRuntime(
    Layer.mergeAll(base, auth, paymentIntents, natsLayer, publisherLayer),
  );
}

function makeTestEnv(): PaymentsEnv {
  return {
    port: 0,
    databaseUrl: "postgres://test",
    authBaseUrl: "http://auth.test",
    natsUrl: "nats://test",
    stripeKey: "sk_test",
    stream: "PAYMENTS",
    ordersStream: "ORDERS",
    otelEndpoint: "http://otel.test:4318",
  };
}

function throwingPaymentIntents(): PaymentIntentClient {
  return {
    createPaymentIntent: () => {
      throw new Error("PaymentIntents not provided to test runtime");
    },
  };
}
