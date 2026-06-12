import { RPCHandler } from "@orpc/server/fetch";
import type { Hono } from "hono";

import { extractTraceparent } from "@tix/observability/otel-http";
import { createRpcApp, standardReadinessChecks } from "@tix/service-runtime/http-app";

import type { OrdersRuntime } from "../runtime/runtime.ts";
import { Database, Nats } from "../runtime/services.ts";
import { createOrdersRouter, type OrdersRequestContext } from "./router.ts";

export function createOrdersApp(runtime: OrdersRuntime): Hono {
  const router = createOrdersRouter(runtime);

  return createRpcApp({
    serviceName: "orders",
    runtime,
    handler: new RPCHandler(router),
    readinessChecks: standardReadinessChecks(Database, Nats),
    // Extract the inbound trace context here, at the wire boundary, so handler
    // spans continue the caller's trace when one is present.
    context: (request): OrdersRequestContext => ({
      otelParent: extractTraceparent(request.headers),
    }),
  });
}
