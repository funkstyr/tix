import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type { Logger } from "pino";

import type { DbClient } from "@tix/db-core/client";
import { requestLogger } from "@tix/observability/request-logger";
import { RPC_PREFIX } from "@tix/observability/rpc";

import type { AuthSessionClient } from "./auth-session-client.ts";
import { createTicketsRouter } from "./router.ts";
import type { ticketsTables } from "./tickets-schema.ts";

export type CreateTicketsAppDeps = {
  db: DbClient<typeof ticketsTables>;
  authClient: AuthSessionClient;
  logger: Logger;
};

export function createTicketsApp(deps: CreateTicketsAppDeps): Hono {
  const router = createTicketsRouter({ db: deps.db, authClient: deps.authClient });
  const rpc = new RPCHandler(router);

  const app = new Hono();

  app.use("*", requestLogger(deps.logger));

  app.get("/health", (c) => c.json({ service: "tickets", ok: true }));

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
