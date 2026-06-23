import { RPCHandler } from "@orpc/server/fetch";
import type { Hono } from "hono";

import { extractTraceparent } from "@tix/observability/otel-http";
import { createRpcApp, standardReadinessChecks } from "@tix/service-runtime/http-app";

import type { TicketsRuntime } from "../runtime/runtime.ts";
import { Database, Nats } from "../runtime/services.ts";
import { createTicketsRouter, type TicketsRequestContext } from "./router.ts";

const SERVICE_TOKEN_HEADER = "x-service-token";

export function createTicketsApp(runtime: TicketsRuntime): Hono {
  const router = createTicketsRouter(runtime);

  return createRpcApp({
    serviceName: "tickets",
    runtime,
    handler: new RPCHandler(router),
    readinessChecks: standardReadinessChecks(Database, Nats),
    // Extract the inbound trace context (so handler spans continue the caller's
    // trace) and the optional service token (used by the reserve handler) here
    // at the wire boundary.
    context: (request): TicketsRequestContext => {
      const headerToken = request.headers.get(SERVICE_TOKEN_HEADER);
      return {
        otelParent: extractTraceparent(request.headers),
        ...(headerToken === null ? {} : { serviceToken: headerToken }),
      };
    },
  });
}
