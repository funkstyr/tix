import { RPCHandler } from "@orpc/server/fetch";
import { Effect } from "effect";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { AUTH_PROXY_PREFIX } from "@tix/contracts/auth";
import { RPC_PREFIX } from "@tix/contracts/rpc";
import { domainAttributes, SpanAttr } from "@tix/observability/attributes";
import { extractTraceparent } from "@tix/observability/otel-http";
import { externalParent } from "@tix/observability/otel-trace";
import { withTimeout } from "@tix/observability/resilience";

import { createAuthProxy } from "./auth-proxy.ts";
import { instrumentEdge } from "./gateway-metrics.ts";
import { createGatewayRouter, type GatewayRequestContext } from "./gateway-router.ts";
import type { GatewayRuntime } from "./gateway-runtime.ts";

export type GatewayAppDeps = {
  runtime: GatewayRuntime;
  webOrigin: string;
  authBaseUrl: string;
  fetch?: typeof globalThis.fetch;
};

export function createGatewayApp(deps: GatewayAppDeps): Hono {
  const router = createGatewayRouter(deps.runtime);
  const rpc = new RPCHandler(router);
  const authProxy = createAuthProxy({
    authBaseUrl: deps.authBaseUrl,
    fetch: deps.fetch ?? globalThis.fetch,
  });

  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => (origin === deps.webOrigin ? origin : null),
      credentials: true,
    }),
  );

  // No request-logger middleware: the per-request span (opened in the router handlers
  // and around the auth proxy below) replaces it, and its logs/timing land in Tempo
  // correlated by trace id (ADR-0009). /health stays untraced.
  app.get("/health", (c) => c.json({ service: "gateway", ok: true }));

  app.all(`${AUTH_PROXY_PREFIX}/*`, (c) => {
    // Run the reverse proxy inside a root span on the runtime so the global context
    // manager makes the active span visible to `traceparentHeaders()` in auth-proxy.
    const otelParent = extractTraceparent(c.req.raw.headers);

    const proxyProgram: Effect.Effect<Response> = instrumentEdge("auth")(
      withTimeout(
        "gateway.proxy.auth",
        Effect.promise(() => authProxy(c.req.raw)),
      ).pipe(
        Effect.withSpan("gateway.proxy.auth.ingress", {
          parent: externalParent(otelParent),
          attributes: domainAttributes({
            [SpanAttr.httpMethod]: c.req.method,
            [SpanAttr.httpRoute]: "auth",
          }),
        }),
      ),
    );

    return deps.runtime.runPromise(proxyProgram);
  });

  app.all(`${RPC_PREFIX}/*`, async (c) => {
    const req = c.req.raw;

    // Extract the inbound trace context here, at the wire boundary, and hand it (with
    // the cookie) to the handlers so their span continues the caller's trace.
    const context: GatewayRequestContext = {
      cookieHeader: req.headers.get("cookie"),
      otelParent: extractTraceparent(req.headers),
      method: req.method,
    };

    const { matched, response } = await rpc.handle(req, { prefix: RPC_PREFIX, context });
    if (matched) return response;

    return c.notFound();
  });

  return app;
}
