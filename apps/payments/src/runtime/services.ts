import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Context, Effect, Layer } from "effect";
import Stripe from "stripe";

import { type AuthSessionClient, createHttpAuthSessionClient } from "@tix/contracts/auth-client";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher, type Publisher } from "@tix/messaging/jetstream";
import { traceparentHeaders } from "@tix/observability/otel-http";

import { paymentsTables } from "../domain/schema.ts";
import {
  createStripePaymentIntentClient,
  type PaymentIntentClient,
} from "../stripe-payment-intent.ts";
import type { PaymentsEnv } from "./config.ts";

export type PaymentsDb = DbClient<typeof paymentsTables>;

// Service tags. Together these replace the hand-injected `deps` object — the
// router and consumers resolve them from the runtime's Layer graph instead of
// receiving them as constructor arguments (ADR-0008).
export class PaymentsConfig extends Context.Tag("payments/PaymentsConfig")<
  PaymentsConfig,
  PaymentsEnv
>() {}

export class Database extends Context.Tag("payments/Database")<Database, PaymentsDb>() {}

export class Nats extends Context.Tag("payments/Nats")<Nats, NatsConnection>() {}

export class EventPublisher extends Context.Tag("payments/EventPublisher")<
  EventPublisher,
  Publisher
>() {}

export class AuthClient extends Context.Tag("payments/AuthClient")<
  AuthClient,
  AuthSessionClient
>() {}

export class PaymentIntents extends Context.Tag("payments/PaymentIntents")<
  PaymentIntents,
  PaymentIntentClient
>() {}

export function makePaymentsConfigLayer(env: PaymentsEnv): Layer.Layer<PaymentsConfig> {
  return Layer.succeed(PaymentsConfig, env);
}

// The db client connects lazily, so acquisition is synchronous; release drains
// the pool. Scope finalization tears it down automatically (LIFO) at shutdown.
export const DatabaseLayer: Layer.Layer<Database, never, PaymentsConfig> = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const env = yield* PaymentsConfig;

    return yield* Effect.acquireRelease(
      Effect.sync(() => createDbClient("payments", env.databaseUrl, { schema: paymentsTables })),
      (client) => Effect.promise(() => client.close()),
    );
  }),
);

export const NatsLayer: Layer.Layer<Nats, never, PaymentsConfig> = Layer.scoped(
  Nats,
  Effect.gen(function* () {
    const env = yield* PaymentsConfig;

    return yield* Effect.acquireRelease(
      Effect.promise(() => connect({ servers: env.natsUrl })),
      (nats) => Effect.promise(() => nats.close()),
    );
  }),
);

// The publisher's wire-level logging falls back to the messaging package's internal
// logger; payments threads no pino logger (ADR-0009). Trace context rides on NATS headers
// the relay injects from the stored outbox value, not from this layer.
export const EventPublisherLayer: Layer.Layer<EventPublisher, never, Nats> = Layer.effect(
  EventPublisher,
  Effect.map(Nats, (nats) => createPublisher(nats)),
);

// `traceparentHeaders` reads the active span (live thanks to the OTel context bridge) on
// every call, so the outbound auth request carries W3C `traceparent` to continue the trace
// at the next instrumented service.
export const AuthClientLayer: Layer.Layer<AuthClient, never, PaymentsConfig> = Layer.effect(
  AuthClient,
  Effect.map(PaymentsConfig, (env) =>
    createHttpAuthSessionClient(env.authBaseUrl, { headers: traceparentHeaders }),
  ),
);

// The Stripe-backed PaymentIntent client. The Stripe SDK owns its own HTTP transport, so
// `traceparent` propagation onto the charge call isn't wired here (ADR-0009 "where
// supported"); the router instead wraps the charge in a span so the outbound latency and
// outcome are still observable.
export const PaymentIntentsLayer: Layer.Layer<PaymentIntents, never, PaymentsConfig> = Layer.effect(
  PaymentIntents,
  Effect.map(PaymentsConfig, (env) => createStripePaymentIntentClient(new Stripe(env.stripeKey))),
);
