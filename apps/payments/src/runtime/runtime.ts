import { Layer, type ManagedRuntime } from "effect";

import {
  eventPublisherLayer,
  makeAuthClientLayer,
  makeDatabaseLayer,
  makeNatsLayer,
} from "@tix/service-runtime/layers";
import { makeServiceRuntime } from "@tix/service-runtime/runtime";
import { AuthClient, EventPublisher, Nats } from "@tix/service-runtime/tags";

import { paymentsTables } from "../domain/schema.ts";
import type { PaymentsEnv } from "./config.ts";
import {
  Database,
  makePaymentsConfigLayer,
  PaymentIntents,
  PaymentIntentsLayer,
  PaymentsConfig,
} from "./services.ts";

export type PaymentsServices =
  | PaymentsConfig
  | Database
  | Nats
  | EventPublisher
  | AuthClient
  | PaymentIntents;

export type PaymentsRuntime = ManagedRuntime.ManagedRuntime<PaymentsServices, never>;

export function makePaymentsLayer(env: PaymentsEnv): Layer.Layer<PaymentsServices> {
  const configLayer = makePaymentsConfigLayer(env);
  const resources = Layer.mergeAll(
    makeDatabaseLayer(Database, {
      schemaName: "payments",
      databaseUrl: env.databaseUrl,
      schema: paymentsTables,
    }),
    makeNatsLayer({ serviceName: "payments", natsUrl: env.natsUrl }),
    makeAuthClientLayer({ authBaseUrl: env.authBaseUrl }),
    PaymentIntentsLayer,
  );
  return eventPublisherLayer.pipe(Layer.provideMerge(resources), Layer.provideMerge(configLayer));
}

export function makePaymentsRuntime(env: PaymentsEnv): PaymentsRuntime {
  return makeServiceRuntime({
    serviceName: "payments",
    otelEndpoint: env.otelEndpoint,
    appLayer: makePaymentsLayer(env),
  });
}
