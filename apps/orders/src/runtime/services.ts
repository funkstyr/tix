import { Context, Effect, Layer } from "effect";

import { type DbClient } from "@tix/db-core/client";
import { traceparentHeaders } from "@tix/observability/otel-http";

import { ordersTables } from "../domain/schema.ts";
import { createHttpTicketsClient, type TicketsClient } from "../tickets-client.ts";
import type { OrdersEnv } from "./config.ts";

export { AuthClient, EventPublisher, Nats } from "@tix/service-runtime/tags";

export type OrdersDb = DbClient<typeof ordersTables>;

export class OrdersConfig extends Context.Tag("orders/OrdersConfig")<OrdersConfig, OrdersEnv>() {}

export class Database extends Context.Tag("orders/Database")<Database, OrdersDb>() {}

export class Tickets extends Context.Tag("orders/Tickets")<Tickets, TicketsClient>() {}

export function makeOrdersConfigLayer(env: OrdersEnv): Layer.Layer<OrdersConfig> {
  return Layer.succeed(OrdersConfig, env);
}

// Outbound oRPC client to the tickets service; `traceparentHeaders` propagates the active
// span so the trace continues at tickets. Stays a per-service domain layer.
export const TicketsLayer: Layer.Layer<Tickets, never, OrdersConfig> = Layer.effect(
  Tickets,
  Effect.map(OrdersConfig, (env) =>
    createHttpTicketsClient(env.ticketsBaseUrl, env.ticketsServiceToken, {
      headers: traceparentHeaders,
    }),
  ),
);
