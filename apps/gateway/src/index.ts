import { serve } from "@hono/node-server";

import { createLogger } from "@tix/observability/logger";

import { createDownstreamClients } from "./downstream-clients.ts";
import { createGatewayApp } from "./gateway-app.ts";
import { parseEnv } from "./gateway-env.ts";
import { createGatewayRouter } from "./gateway-router.ts";

const fallbackLogger = createLogger({ name: "gateway" });

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const logger = createLogger({ name: "gateway", level: env.logLevel });

  const clients = createDownstreamClients({
    ticketsBaseUrl: env.ticketsBaseUrl,
    ordersBaseUrl: env.ordersBaseUrl,
    paymentsBaseUrl: env.paymentsBaseUrl,
    authBaseUrl: env.authBaseUrl,
  });

  const router = createGatewayRouter({ clients });

  const app = createGatewayApp({
    logger,
    webOrigin: env.webOrigin,
    router,
    authBaseUrl: env.authBaseUrl,
  });

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    logger.info({ port: info.port }, "gateway service listening");
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "shutting down gateway service");
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  fallbackLogger.fatal({ err }, "gateway service failed to start");
  process.exit(1);
});
