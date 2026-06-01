import { Context, Effect, Layer } from "effect";
import Stripe from "stripe";

import { type DbClient } from "@tix/db-core/client";

import { paymentsTables } from "../domain/schema.ts";
import {
  createStripePaymentIntentClient,
  type PaymentIntentClient,
} from "../stripe-payment-intent.ts";
import type { PaymentsEnv } from "./config.ts";

export { AuthClient, EventPublisher, Nats } from "@tix/service-runtime/tags";

export type PaymentsDb = DbClient<typeof paymentsTables>;

export class PaymentsConfig extends Context.Tag("payments/PaymentsConfig")<
  PaymentsConfig,
  PaymentsEnv
>() {}

export class Database extends Context.Tag("payments/Database")<Database, PaymentsDb>() {}

export class PaymentIntents extends Context.Tag("payments/PaymentIntents")<
  PaymentIntents,
  PaymentIntentClient
>() {}

export function makePaymentsConfigLayer(env: PaymentsEnv): Layer.Layer<PaymentsConfig> {
  return Layer.succeed(PaymentsConfig, env);
}

// The Stripe-backed PaymentIntent client. The Stripe SDK owns its own HTTP transport, so
// `traceparent` propagation isn't wired here (ADR-0009 "where supported"); the router wraps
// the charge in a span instead. Stays a per-service domain layer.
export const PaymentIntentsLayer: Layer.Layer<PaymentIntents, never, PaymentsConfig> = Layer.effect(
  PaymentIntents,
  Effect.map(PaymentsConfig, (env) => createStripePaymentIntentClient(new Stripe(env.stripeKey))),
);
