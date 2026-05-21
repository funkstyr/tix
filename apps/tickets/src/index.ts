import { serve } from "@hono/node-server";

import { createDbClient } from "@tix/db-core/client";
import { createLogger } from "@tix/observability/logger";

import { createHttpAuthSessionClient } from "./auth-session-client.ts";
import { createTicketsApp } from "./tickets-app.ts";
import { ticketsTables } from "./tickets-schema.ts";

const DEFAULT_PORT = 4002;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);

  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;

  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`invalid TICKETS_HTTP_PORT: ${raw}`);
  }

  return n;
}

async function main(): Promise<void> {
  const logger = createLogger({ name: "tickets", level: process.env["LOG_LEVEL"] ?? "info" });

  const port = parsePort(process.env["TICKETS_HTTP_PORT"]);
  const databaseUrl = requireEnv("DATABASE_URL");
  const authBaseUrl = requireEnv("AUTH_BASE_URL");

  const db = createDbClient("tickets", databaseUrl, { schema: ticketsTables });
  const authClient = createHttpAuthSessionClient(authBaseUrl);
  const app = createTicketsApp({ db, authClient, logger });

  serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, "tickets service listening");
  });
}

main().catch((err: unknown) => {
  createLogger({ name: "tickets" }).fatal({ err }, "tickets service failed to start");
  process.exit(1);
});
