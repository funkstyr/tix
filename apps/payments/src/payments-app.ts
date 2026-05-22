import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type { Logger } from "pino";

import { RPC_PREFIX } from "@tix/contracts/rpc";
import { requestLogger } from "@tix/observability/request-logger";

export type CreatePaymentsAppDeps = {
  logger: Logger;
};

// TODO: wire payments router — `/rpc/*` 404s until procedures are registered here
const paymentsRouter = {} as const;

export function createPaymentsApp(deps: CreatePaymentsAppDeps): Hono {
  const rpc = new RPCHandler(paymentsRouter);

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
