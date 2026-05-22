import { serve } from "@hono/node-server";
import { ArkErrors, type } from "arktype";
import type { Level } from "pino";

import { createDbClient } from "@tix/db-core/client";
import { createLogger } from "@tix/observability/logger";

import { createPaymentsApp } from "./payments-app.ts";
import { paymentsTables } from "./payments-schema.ts";

const DEFAULT_PORT = 4004;

const envSchema = type({
  "PAYMENTS_HTTP_PORT?": "string.numeric.parse",
  DATABASE_URL: "string > 0",
  "LOG_LEVEL?": "'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'",
});

type Env = {
  port: number;
  databaseUrl: string;
  logLevel: Level;
};

function parseEnv(): Env {
  const parsed = envSchema(process.env);
  if (parsed instanceof ArkErrors) {
    throw new Error(`invalid environment: ${parsed.summary}`);
  }

  const port = parsed.PAYMENTS_HTTP_PORT ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid PAYMENTS_HTTP_PORT: ${port}`);
  }

  return { port, databaseUrl: parsed.DATABASE_URL, logLevel: parsed.LOG_LEVEL ?? "info" };
}

const fallbackLogger = createLogger({ name: "payments" });

async function main(): Promise<void> {
  const { port, databaseUrl, logLevel } = parseEnv();
  const logger = createLogger({ name: "payments", level: logLevel });

  const db = createDbClient("payments", databaseUrl, { schema: paymentsTables });

  const app = createPaymentsApp({ logger });

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, "payments service listening");
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "shutting down payments service");
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
  fallbackLogger.fatal({ err }, "payments service failed to start");
  process.exit(1);
});
