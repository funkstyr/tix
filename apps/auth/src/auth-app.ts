import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type { Logger } from "pino";

import { RPC_PREFIX } from "@tix/contracts/rpc";
import { requestLogger } from "@tix/observability/request-logger";

import type { AuthInstance } from "./auth-instance.ts";
import { createAuthRouter } from "./router.ts";

export type CreateAuthAppDeps = {
  auth: AuthInstance;
  logger: Logger;
};

export function createAuthApp(deps: CreateAuthAppDeps): Hono {
  const router = createAuthRouter({ auth: deps.auth });
  const rpc = new RPCHandler(router);

  const app = new Hono();

  app.use("*", requestLogger(deps.logger));

  app.get("/health", (c) => c.json({ service: "auth", ok: true }));

  app.all("/api/auth/*", (c) => deps.auth.handler(c.req.raw));

  app.all(`${RPC_PREFIX}/*`, async (c) => {
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: RPC_PREFIX,
      context: {},
    });
    if (matched) return response;

    return c.notFound();
  });

  return app;
}
