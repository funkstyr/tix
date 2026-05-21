import { serve } from "@hono/node-server";
import { connect } from "@nats-io/transport-node";

import { createHttpAuthSessionClient } from "@tix/contracts/auth-client";
import { createDbClient } from "@tix/db-core/client";
import { startOutboxRelay } from "@tix/db-core/outbox";
import { createPublisher } from "@tix/messaging/jetstream";
import { createLogger } from "@tix/observability/logger";

import { createTicketsApp } from "./tickets-app.ts";
import { ticketsOutbox, ticketsTables } from "./tickets-schema.ts";

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
  const natsUrl = requireEnv("NATS_URL");
  const serviceToken = requireEnv("TICKETS_SERVICE_TOKEN");

  const db = createDbClient("tickets", databaseUrl, { schema: ticketsTables });
  const authClient = createHttpAuthSessionClient(authBaseUrl);
  const app = createTicketsApp({ db, authClient, serviceToken, logger });

  const nats = await connect({ servers: natsUrl });
  const publisher = createPublisher(nats, { logger });
  const relay = startOutboxRelay(db.db, ticketsOutbox, publisher.publish, { logger });

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, "tickets service listening");
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "shutting down tickets service");
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await relay.stop();
    await nats.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  createLogger({ name: "tickets" }).fatal({ err }, "tickets service failed to start");
  process.exit(1);
});
