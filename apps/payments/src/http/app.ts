import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";

import { RPC_PREFIX } from "@tix/contracts/rpc";
import { extractTraceparent } from "@tix/observability/otel-http";

import type { PaymentsRuntime } from "../runtime/runtime.ts";
import { createPaymentsRouter, type PaymentsRequestContext } from "./router.ts";

export function createPaymentsApp(runtime: PaymentsRuntime): Hono {
  const router = createPaymentsRouter(runtime);
  const rpc = new RPCHandler(router);

  const app = new Hono();

  // No request-logger middleware: the per-request span (opened in the router handler)
  // replaces it, and its logs/timing land in Tempo correlated by trace id (ADR-0009).
  app.get("/health", (c) => c.json({ service: "payments", ok: true }));

  app.all(`${RPC_PREFIX}/*`, async (c) => {
    // Extract the inbound trace context here, at the wire boundary, and hand it to the
    // handler so its span continues the caller's trace when one is present.
    const context: PaymentsRequestContext = { otelParent: extractTraceparent(c.req.raw.headers) };

    const { matched, response } = await rpc.handle(c.req.raw, { prefix: RPC_PREFIX, context });
    if (matched) return response;

    return c.notFound();
  });

  return app;
}
