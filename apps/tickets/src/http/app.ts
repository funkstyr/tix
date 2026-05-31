import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";

import { RPC_PREFIX } from "@tix/contracts/rpc";
import { extractTraceparent } from "@tix/observability/otel-http";

import type { TicketsRuntime } from "../runtime/runtime.ts";
import { createTicketsRouter, type TicketsRequestContext } from "./router.ts";

const SERVICE_TOKEN_HEADER = "x-service-token";

export function createTicketsApp(runtime: TicketsRuntime): Hono {
  const router = createTicketsRouter(runtime);
  const rpc = new RPCHandler(router);

  const app = new Hono();

  // No request-logger middleware: the per-request span (opened in the router handlers)
  // replaces it, and its logs/timing land in Tempo correlated by trace id (ADR-0009).
  app.get("/health", (c) => c.json({ service: "tickets", ok: true }));

  app.all(`${RPC_PREFIX}/*`, async (c) => {
    // Extract the inbound trace context (so handler spans continue the caller's trace) and
    // the optional service token (used by the reserve handler) here at the wire boundary.
    const headerToken = c.req.header(SERVICE_TOKEN_HEADER);
    const context: TicketsRequestContext = {
      otelParent: extractTraceparent(c.req.raw.headers),
      ...(headerToken === undefined ? {} : { serviceToken: headerToken }),
    };

    const { matched, response } = await rpc.handle(c.req.raw, { prefix: RPC_PREFIX, context });
    if (matched) return response;

    return c.notFound();
  });

  return app;
}
