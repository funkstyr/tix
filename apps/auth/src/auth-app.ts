import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type { Logger } from "pino";

import type { AuthInstance } from "./auth-instance.ts";
import { requestLogger } from "./auth-logger.ts";
import { createAuthRouter } from "./router.ts";

const RPC_PREFIX = "/rpc";

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
