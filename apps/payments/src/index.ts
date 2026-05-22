import { serve } from "@hono/node-server";
import { ArkErrors, type } from "arktype";

import { createLogger } from "@tix/observability/logger";

import { createPaymentsApp } from "./payments-app.ts";

const DEFAULT_PORT = 4004;

const envSchema = type({
  "PAYMENTS_HTTP_PORT?": "string.numeric.parse",
  "LOG_LEVEL?": "'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'",
});

type Env = {
  port: number;
  logLevel: string;
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

  return { port, logLevel: parsed.LOG_LEVEL ?? "info" };
}

async function main(): Promise<void> {
  const { port, logLevel } = parseEnv();
  const logger = createLogger({ name: "payments", level: logLevel });

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
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  createLogger({ name: "payments" }).fatal({ err }, "payments service failed to start");
  process.exit(1);
});
