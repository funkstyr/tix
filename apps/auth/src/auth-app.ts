import { RPCHandler } from "@orpc/server/fetch";
import { Effect } from "effect";
import { Hono } from "hono";

import { RPC_PREFIX } from "@tix/contracts/rpc";
import { extractTraceparent } from "@tix/observability/otel-http";
import { externalParent } from "@tix/observability/otel-trace";
import { withTimeout } from "@tix/observability/resilience";

import { instrumentAuth } from "./auth-metrics.ts";
import type { AuthRuntime } from "./auth-runtime.ts";
import { Auth } from "./auth-services.ts";
import { type AuthRequestContext, createAuthRouter } from "./router.ts";

export type CreateAuthAppDeps = {
  runtime: AuthRuntime;
};

export function createAuthApp(deps: CreateAuthAppDeps): Hono {
  const router = createAuthRouter(deps.runtime);
  const rpc = new RPCHandler(router);

  const app = new Hono();

  // No request-logger middleware: the per-request span (opened in the router handlers and
  // around the better-auth handler below) replaces it, and its logs/timing land in Tempo
  // correlated by trace id (ADR-0009). /health stays untraced.
  app.get("/health", (c) => c.json({ service: "auth", ok: true }));

  app.all("/api/auth/*", (c) => {
    // The native better-auth endpoints (used by the SPA) run inside a root span on the
    // runtime so their logs are trace-correlated and the global context manager makes the
    // active span visible to any outbound propagation. better-auth resolves `Auth` from
    // the runtime just like the oRPC handlers. The whole surface aggregates under the
    // `native` op so the RED metrics aren't blind to SPA traffic — individual endpoints
    // aren't broken out because better-auth multiplexes them behind one catch-all route.
    const otelParent = extractTraceparent(c.req.raw.headers);

    const program = Effect.gen(function* () {
      const auth = yield* Auth;

      return yield* withTimeout(
        "auth.handler.dispatch",
        Effect.promise(() => auth.handler(c.req.raw)),
      );
    }).pipe(
      Effect.withSpan("auth.handler", { parent: externalParent(otelParent) }),
      instrumentAuth("native"),
    );

    return deps.runtime.runPromise(program);
  });

  app.all(`${RPC_PREFIX}/*`, async (c) => {
    const req = c.req.raw;

    // Extract the inbound trace context here, at the wire boundary, and hand it to the
    // handlers so their span continues the caller's trace.
    const context: AuthRequestContext = {
      otelParent: extractTraceparent(req.headers),
    };

    const { matched, response } = await rpc.handle(req, { prefix: RPC_PREFIX, context });
    if (matched) return response;

    return c.notFound();
  });

  return app;
}
