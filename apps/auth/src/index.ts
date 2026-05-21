import { serve } from "@hono/node-server";

import { createDbClient } from "@tix/db-core/client";
import { createLogger } from "@tix/observability/logger";

import { createAuthApp } from "./auth-app.ts";
import { createAuth } from "./auth-instance.ts";
import { authTables } from "./auth-schema.ts";

const DEFAULT_PORT = 4001;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);

  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;

  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`invalid AUTH_HTTP_PORT: ${raw}`);
  }

  return n;
}

async function main(): Promise<void> {
  const logger = createLogger({ name: "auth", level: process.env["LOG_LEVEL"] ?? "info" });

  const port = parsePort(process.env["AUTH_HTTP_PORT"]);
  const databaseUrl = requireEnv("DATABASE_URL");
  const secret = requireEnv("BETTER_AUTH_SECRET");
  const baseURL = process.env["AUTH_BASE_URL"] ?? `http://localhost:${port}`;

  const { db } = createDbClient("auth", databaseUrl, { schema: authTables });
  const auth = createAuth({ db, secret, baseURL });
  const app = createAuthApp({ auth, logger });

  serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, "auth service listening");
  });
}

main().catch((err: unknown) => {
  createLogger({ name: "auth" }).fatal({ err }, "auth service failed to start");
  process.exit(1);
});
