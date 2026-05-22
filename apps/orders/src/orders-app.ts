import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type { Logger } from "pino";

import type { AuthSessionClient } from "@tix/contracts/auth-client";
import { RPC_PREFIX } from "@tix/contracts/rpc";
import type { DbClient } from "@tix/db-core/client";
import { requestLogger } from "@tix/observability/request-logger";

import type { ordersTables } from "./orders-schema.ts";
import { createOrdersRouter } from "./router.ts";
import type { TicketsClient } from "./tickets-client.ts";

export type CreateOrdersAppDeps = {
  db: DbClient<typeof ordersTables>;
  authClient: AuthSessionClient;
  ticketsClient: TicketsClient;
  reservationTtlMs: number;
  logger: Logger;
};

export function createOrdersApp(deps: CreateOrdersAppDeps): Hono {
  const router = createOrdersRouter({
    db: deps.db,
    authClient: deps.authClient,
    ticketsClient: deps.ticketsClient,
    reservationTtlMs: deps.reservationTtlMs,
    logger: deps.logger,
  });
  const rpc = new RPCHandler(router);

  const app = new Hono();

  app.use("*", requestLogger(deps.logger));

  app.get("/health", (c) => c.json({ service: "orders", ok: true }));

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
