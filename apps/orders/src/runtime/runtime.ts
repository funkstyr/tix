import { Layer, type ManagedRuntime } from "effect";

import {
  eventPublisherLayer,
  makeAuthClientLayer,
  makeDatabaseLayer,
  makeNatsLayer,
} from "@tix/service-runtime/layers";
import { makeServiceRuntime } from "@tix/service-runtime/runtime";
import { AuthClient, EventPublisher, Nats } from "@tix/service-runtime/tags";

import { ordersTables } from "../domain/schema.ts";
import type { OrdersEnv } from "./config.ts";
import { Database, makeOrdersConfigLayer, OrdersConfig, Tickets, TicketsLayer } from "./services.ts";

export type OrdersServices = OrdersConfig | Database | Nats | EventPublisher | AuthClient | Tickets;
export type OrdersRuntime = ManagedRuntime.ManagedRuntime<OrdersServices, never>;

export function makeOrdersLayer(env: OrdersEnv): Layer.Layer<OrdersServices> {
  const configLayer = makeOrdersConfigLayer(env);
  const resources = Layer.mergeAll(
    makeDatabaseLayer(Database, {
      schemaName: "orders",
      databaseUrl: env.databaseUrl,
      schema: ordersTables,
    }),
    makeNatsLayer({ serviceName: "orders", natsUrl: env.natsUrl }),
    makeAuthClientLayer({ authBaseUrl: env.authBaseUrl }),
    TicketsLayer,
  );
  return eventPublisherLayer.pipe(Layer.provideMerge(resources), Layer.provideMerge(configLayer));
}

export function makeOrdersRuntime(env: OrdersEnv): OrdersRuntime {
  return makeServiceRuntime({
    serviceName: "orders",
    otelEndpoint: env.otelEndpoint,
    appLayer: makeOrdersLayer(env),
  });
}
