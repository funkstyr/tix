import { serve } from "@hono/node-server";
import { ArkErrors, type } from "arktype";
import type { Level } from "pino";

import { createDbClient } from "@tix/db-core/client";
import { createLogger } from "@tix/observability/logger";

import { createAuthApp } from "./auth-app.ts";
import { createAuth } from "./auth-instance.ts";
import { authTables } from "./auth-schema.ts";

const DEFAULT_PORT = 4001;

const envSchema = type({
  "AUTH_HTTP_PORT?": "string.numeric.parse",
  DATABASE_URL: "string > 0",
  BETTER_AUTH_SECRET: "string > 0",
  "AUTH_BASE_URL?": "string > 0",
  "LOG_LEVEL?": "'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'",
});

type Env = {
  port: number;
  databaseUrl: string;
  secret: string;
  baseURL: string;
  logLevel: Level;
};

function parseEnv(): Env {
  const parsed = envSchema(process.env);
  if (parsed instanceof ArkErrors) {
    throw new Error(`invalid environment: ${parsed.summary}`);
  }

  const port = parsed.AUTH_HTTP_PORT ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid AUTH_HTTP_PORT: ${port}`);
  }

  return {
    port,
    databaseUrl: parsed.DATABASE_URL,
    secret: parsed.BETTER_AUTH_SECRET,
    baseURL: parsed.AUTH_BASE_URL ?? `http://localhost:${port}`,
    logLevel: parsed.LOG_LEVEL ?? "info",
  };
}

const fallbackLogger = createLogger({ name: "auth" });

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger({ name: "auth", level: env.logLevel });

  const { db } = createDbClient("auth", env.databaseUrl, { schema: authTables });
  const auth = createAuth({ db, secret: env.secret, baseURL: env.baseURL });
  const app = createAuthApp({ auth, logger });

  serve({ fetch: app.fetch, port: env.port }, (info) => {
    logger.info({ port: info.port }, "auth service listening");
  });
}

main().catch((err: unknown) => {
  fallbackLogger.fatal({ err }, "auth service failed to start");
  process.exit(1);
});
