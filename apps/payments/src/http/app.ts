import { RPCHandler } from "@orpc/server/fetch";
import type { Hono } from "hono";

import { extractTraceparent } from "@tix/observability/otel-http";
import { createRpcApp, standardReadinessChecks } from "@tix/service-runtime/http-app";

import type { PaymentsRuntime } from "../runtime/runtime.ts";
import { Database, Nats } from "../runtime/services.ts";
import { createPaymentsRouter, type PaymentsRequestContext } from "./router.ts";

export function createPaymentsApp(runtime: PaymentsRuntime): Hono {
  const router = createPaymentsRouter(runtime);

  return createRpcApp({
    serviceName: "payments",
    runtime,
    handler: new RPCHandler(router),
    readinessChecks: standardReadinessChecks(Database, Nats),
    context: (request): PaymentsRequestContext => ({
      otelParent: extractTraceparent(request.headers),
    }),
  });
}
