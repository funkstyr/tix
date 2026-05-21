import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type { Logger } from "pino";

import type { AuthSessionClient } from "@tix/contracts/auth-client";
import { RPC_PREFIX } from "@tix/contracts/rpc";
import type { DbClient } from "@tix/db-core/client";
import { requestLogger } from "@tix/observability/request-logger";

import { createTicketsRouter } from "./router.ts";
import type { ticketsTables } from "./tickets-schema.ts";

const SERVICE_TOKEN_HEADER = "x-service-token";

export type CreateTicketsAppDeps = {
  db: DbClient<typeof ticketsTables>;
  authClient: AuthSessionClient;
  serviceToken: string;
  logger: Logger;
};

export function createTicketsApp(deps: CreateTicketsAppDeps): Hono {
  const router = createTicketsRouter({
    db: deps.db,
    authClient: deps.authClient,
    serviceToken: deps.serviceToken,
  });
  const rpc = new RPCHandler(router);

  const app = new Hono();

  app.use("*", requestLogger(deps.logger));

  app.get("/health", (c) => c.json({ service: "tickets", ok: true }));

  app.all(`${RPC_PREFIX}/*`, async (c) => {
    const headerToken = c.req.header(SERVICE_TOKEN_HEADER);

    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: RPC_PREFIX,
      context: headerToken === undefined ? {} : { serviceToken: headerToken },
    });
    if (matched) return response;

    return c.notFound();
  });

  return app;
}
