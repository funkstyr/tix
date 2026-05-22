import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Logger } from "pino";

import { RPC_PREFIX } from "@tix/contracts/rpc";
import { requestLogger } from "@tix/observability/request-logger";

import { AUTH_PROXY_PREFIX, createAuthProxy } from "./auth-proxy.ts";
import type { GatewayRouter } from "./gateway-router.ts";

export type GatewayAppDeps = {
  logger: Logger;
  webOrigin: string;
  router: GatewayRouter;
  authBaseUrl: string;
  fetch?: typeof globalThis.fetch;
};

export function createGatewayApp(deps: GatewayAppDeps): Hono {
  const rpc = new RPCHandler(deps.router);
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

  app.use("*", requestLogger(deps.logger));

  app.get("/health", (c) => c.json({ service: "gateway", ok: true }));

  app.all(`${AUTH_PROXY_PREFIX}/*`, (c) => authProxy(c.req.raw));

  app.all(`${RPC_PREFIX}/*`, async (c) => {
    const req = c.req.raw;

    const { matched, response } = await rpc.handle(req, {
      prefix: RPC_PREFIX,
      context: {
        cookieHeader: req.headers.get("cookie"),
      },
    });
    if (matched) return response;

    return c.notFound();
  });

  return app;
}
