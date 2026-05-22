import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type { Logger } from "pino";

import type { AuthSessionClient } from "@tix/contracts/auth-client";
import { RPC_PREFIX } from "@tix/contracts/rpc";
import type { DbClient } from "@tix/db-core/client";
import { requestLogger } from "@tix/observability/request-logger";

import { type paymentsTables } from "./payments-schema.ts";
import { createPaymentsRouter } from "./router.ts";
import type { PaymentIntentClient } from "./stripe-payment-intent.ts";

export type CreatePaymentsAppDeps = {
  db: DbClient<typeof paymentsTables>;
  authClient: AuthSessionClient;
  paymentIntentClient: PaymentIntentClient;
  logger: Logger;
};

export function createPaymentsApp(deps: CreatePaymentsAppDeps): Hono {
  const router = createPaymentsRouter({
    db: deps.db,
    authClient: deps.authClient,
    paymentIntentClient: deps.paymentIntentClient,
  });
  const rpc = new RPCHandler(router);

  const app = new Hono();

  app.use("*", requestLogger(deps.logger));

  app.get("/health", (c) => c.json({ service: "payments", ok: true }));

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
