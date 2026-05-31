import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";

import { RPC_PREFIX } from "@tix/contracts/rpc";
import { requestLogger } from "@tix/observability/request-logger";

import type { OrdersRuntime } from "../runtime/runtime.ts";
import { InfraLogger } from "../runtime/services.ts";
import { createOrdersRouter } from "./router.ts";

export function createOrdersApp(runtime: OrdersRuntime): Hono {
  const router = createOrdersRouter(runtime);
  const rpc = new RPCHandler(router);

  // The wire-level request logger stays pino (ADR-0008 keeps pino until the final
  // cleanup slice); pull it from the runtime so there's a single logger instance.
  const logger = runtime.runSync(InfraLogger);

  const app = new Hono();

  app.use("*", requestLogger(logger));

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
