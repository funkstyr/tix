import { serve } from "@hono/node-server";
import { connect } from "@nats-io/transport-node";
import { ArkErrors, type } from "arktype";
import type { Level } from "pino";

import { createHttpAuthSessionClient } from "@tix/contracts/auth-client";
import { ORDERS_STREAM } from "@tix/contracts/subjects";
import { createDbClient } from "@tix/db-core/client";
import { startOutboxRelay } from "@tix/db-core/outbox";
import { createPublisher } from "@tix/messaging/jetstream";
import { createLogger } from "@tix/observability/logger";

import { createTicketsApp } from "./tickets-app.ts";
import { startTicketsReleasedConsumer } from "./tickets-consumer.ts";
import { ticketsOutbox, ticketsTables } from "./tickets-schema.ts";

const DEFAULT_PORT = 4002;

const envSchema = type({
  "TICKETS_HTTP_PORT?": "string.numeric.parse",
  DATABASE_URL: "string > 0",
  AUTH_BASE_URL: "string > 0",
  NATS_URL: "string > 0",
  TICKETS_SERVICE_TOKEN: "string > 0",
  "ORDERS_STREAM?": "string > 0",
  "LOG_LEVEL?": "'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'",
});

type Env = {
  port: number;
  databaseUrl: string;
  authBaseUrl: string;
  natsUrl: string;
  serviceToken: string;
  ordersStream: string;
  logLevel: Level;
};

function parseEnv(): Env {
  const parsed = envSchema(process.env);
  if (parsed instanceof ArkErrors) {
    throw new Error(`invalid environment: ${parsed.summary}`);
  }

  const port = parsed.TICKETS_HTTP_PORT ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid TICKETS_HTTP_PORT: ${port}`);
  }

  return {
    port,
    databaseUrl: parsed.DATABASE_URL,
    authBaseUrl: parsed.AUTH_BASE_URL,
    natsUrl: parsed.NATS_URL,
    serviceToken: parsed.TICKETS_SERVICE_TOKEN,
    ordersStream: parsed.ORDERS_STREAM ?? ORDERS_STREAM,
    logLevel: parsed.LOG_LEVEL ?? "info",
  };
}

const fallbackLogger = createLogger({ name: "tickets" });

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger({ name: "tickets", level: env.logLevel });

  const db = createDbClient("tickets", env.databaseUrl, { schema: ticketsTables });
  const authClient = createHttpAuthSessionClient(env.authBaseUrl);
  const app = createTicketsApp({ db, authClient, serviceToken: env.serviceToken, logger });

  const nats = await connect({ servers: env.natsUrl });
  const publisher = createPublisher(nats, { logger });
  const relay = startOutboxRelay(db.db, ticketsOutbox, publisher.publish, { logger });
  const releasedConsumer = await startTicketsReleasedConsumer({
    db,
    nats,
    stream: env.ordersStream,
    logger,
  });

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
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
    await releasedConsumer.stop();
    await relay.stop();
    await nats.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  fallbackLogger.fatal({ err }, "tickets service failed to start");
  process.exit(1);
});
