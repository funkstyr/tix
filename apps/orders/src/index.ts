import { serve } from "@hono/node-server";
import { connect } from "@nats-io/transport-node";
import { ArkErrors, type } from "arktype";
import type { Level } from "pino";

import { createHttpAuthSessionClient } from "@tix/contracts/auth-client";
import { ORDERS_STREAM, PAYMENTS_STREAM, TICKETS_STREAM } from "@tix/contracts/subjects";
import { createDbClient } from "@tix/db-core/client";
import { startOutboxRelay } from "@tix/db-core/outbox";
import { createPublisher } from "@tix/messaging/jetstream";
import { createLogger } from "@tix/observability/logger";

import { createOrdersApp } from "./orders-app.ts";
import { startOrdersExpiredConsumer } from "./orders-consumer.ts";
import { startOrdersPaymentCreatedConsumer } from "./orders-payment-consumer.ts";
import { ordersOutbox, ordersTables } from "./orders-schema.ts";
import { createHttpTicketsClient } from "./tickets-client.ts";
import {
  startTicketsCreatedConsumer,
  startTicketsUpdatedConsumer,
} from "./tickets-replica-consumer.ts";

const DEFAULT_PORT = 4003;
const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;

const envSchema = type({
  "ORDERS_HTTP_PORT?": "string.numeric.parse",
  DATABASE_URL: "string > 0",
  AUTH_BASE_URL: "string > 0",
  TICKETS_BASE_URL: "string > 0",
  TICKETS_SERVICE_TOKEN: "string > 0",
  NATS_URL: "string > 0",
  "ORDERS_STREAM?": "string > 0",
  "PAYMENTS_STREAM?": "string > 0",
  "TICKETS_STREAM?": "string > 0",
  "RESERVATION_TTL_MS?": "string.numeric.parse",
  "LOG_LEVEL?": "'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'",
});

type Env = {
  port: number;
  databaseUrl: string;
  authBaseUrl: string;
  ticketsBaseUrl: string;
  ticketsServiceToken: string;
  natsUrl: string;
  stream: string;
  paymentsStream: string;
  ticketsStream: string;
  reservationTtlMs: number;
  logLevel: Level;
};

function parseEnv(): Env {
  const parsed = envSchema(process.env);
  if (parsed instanceof ArkErrors) {
    throw new Error(`invalid environment: ${parsed.summary}`);
  }

  const port = parsed.ORDERS_HTTP_PORT ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid ORDERS_HTTP_PORT: ${port}`);
  }

  const reservationTtlMs = parsed.RESERVATION_TTL_MS ?? DEFAULT_RESERVATION_TTL_MS;
  if (!Number.isInteger(reservationTtlMs) || reservationTtlMs <= 0) {
    throw new Error(`invalid RESERVATION_TTL_MS: ${reservationTtlMs}`);
  }

  return {
    port,
    databaseUrl: parsed.DATABASE_URL,
    authBaseUrl: parsed.AUTH_BASE_URL,
    ticketsBaseUrl: parsed.TICKETS_BASE_URL,
    ticketsServiceToken: parsed.TICKETS_SERVICE_TOKEN,
    natsUrl: parsed.NATS_URL,
    stream: parsed.ORDERS_STREAM ?? ORDERS_STREAM,
    paymentsStream: parsed.PAYMENTS_STREAM ?? PAYMENTS_STREAM,
    ticketsStream: parsed.TICKETS_STREAM ?? TICKETS_STREAM,
    reservationTtlMs,
    logLevel: parsed.LOG_LEVEL ?? "info",
  };
}

const fallbackLogger = createLogger({ name: "orders" });

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger({ name: "orders", level: env.logLevel });

  const db = createDbClient("orders", env.databaseUrl, { schema: ordersTables });
  const authClient = createHttpAuthSessionClient(env.authBaseUrl);
  const ticketsClient = createHttpTicketsClient(env.ticketsBaseUrl, env.ticketsServiceToken);
  const app = createOrdersApp({
    db,
    authClient,
    ticketsClient,
    reservationTtlMs: env.reservationTtlMs,
    logger,
  });

  const nats = await connect({ servers: env.natsUrl });
  const publisher = createPublisher(nats, { logger });
  const relay = startOutboxRelay(db.db, ordersOutbox, publisher.publish, { logger });
  const expiredConsumer = await startOrdersExpiredConsumer({
    db,
    nats,
    stream: env.stream,
    logger,
  });
  const paymentCreatedConsumer = await startOrdersPaymentCreatedConsumer({
    db,
    nats,
    stream: env.paymentsStream,
    logger,
  });
  const ticketsCreatedConsumer = await startTicketsCreatedConsumer({
    db,
    nats,
    stream: env.ticketsStream,
    logger,
  });
  const ticketsUpdatedConsumer = await startTicketsUpdatedConsumer({
    db,
    nats,
    stream: env.ticketsStream,
    logger,
  });

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
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
    await ticketsUpdatedConsumer.stop();
    await ticketsCreatedConsumer.stop();
    await paymentCreatedConsumer.stop();
    await expiredConsumer.stop();
    await relay.stop();
    await nats.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  fallbackLogger.fatal({ err }, "orders service failed to start");
  process.exit(1);
});
