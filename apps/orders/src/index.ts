import { serve } from "@hono/node-server";

import { createDbClient } from "@tix/db-core/client";
import { createLogger } from "@tix/observability/logger";

import { createHttpAuthSessionClient } from "./auth-session-client.ts";
import { createOrdersApp } from "./orders-app.ts";
import { ordersTables } from "./orders-schema.ts";
import { createHttpTicketsClient } from "./tickets-client.ts";

const DEFAULT_PORT = 4003;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);

  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;

  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`invalid ORDERS_HTTP_PORT: ${raw}`);
  }

  return n;
}

async function main(): Promise<void> {
  const logger = createLogger({ name: "orders", level: process.env["LOG_LEVEL"] ?? "info" });

  const port = parsePort(process.env["ORDERS_HTTP_PORT"]);
  const databaseUrl = requireEnv("DATABASE_URL");
  const authBaseUrl = requireEnv("AUTH_BASE_URL");
  const ticketsBaseUrl = requireEnv("TICKETS_BASE_URL");
  const ticketsServiceToken = requireEnv("TICKETS_SERVICE_TOKEN");

  const db = createDbClient("orders", databaseUrl, { schema: ordersTables });
  const authClient = createHttpAuthSessionClient(authBaseUrl);
  const ticketsClient = createHttpTicketsClient(ticketsBaseUrl, ticketsServiceToken);
  const app = createOrdersApp({ db, authClient, ticketsClient, logger });

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, "orders service listening");
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "shutting down orders service");
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  createLogger({ name: "orders" }).fatal({ err }, "orders service failed to start");
  process.exit(1);
});
