import { serve } from "@hono/node-server";
import { connect } from "@nats-io/transport-node";
import { ArkErrors, type } from "arktype";
import type { Level } from "pino";
import Stripe from "stripe";

import { createHttpAuthSessionClient } from "@tix/contracts/auth-client";
import { PAYMENTS_STREAM } from "@tix/contracts/subjects";
import { createDbClient } from "@tix/db-core/client";
import { startOutboxRelay } from "@tix/db-core/outbox";
import { createPublisher } from "@tix/messaging/jetstream";
import { createLogger } from "@tix/observability/logger";

import { createPaymentsApp } from "./payments-app.ts";
import {
  startPaymentsOrderCancelledConsumer,
  startPaymentsOrderCreatedConsumer,
} from "./payments-consumer.ts";
import { paymentsOutbox, paymentsTables } from "./payments-schema.ts";
import { createStripePaymentIntentClient } from "./stripe-payment-intent.ts";

const DEFAULT_PORT = 4004;

const envSchema = type({
  "PAYMENTS_HTTP_PORT?": "string.numeric.parse",
  DATABASE_URL: "string > 0",
  AUTH_BASE_URL: "string > 0",
  NATS_URL: "string > 0",
  STRIPE_KEY: "string > 0",
  "PAYMENTS_STREAM?": "string > 0",
  "LOG_LEVEL?": "'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'",
});

type Env = {
  port: number;
  databaseUrl: string;
  authBaseUrl: string;
  natsUrl: string;
  stripeKey: string;
  stream: string;
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

  return {
    port,
    databaseUrl: parsed.DATABASE_URL,
    authBaseUrl: parsed.AUTH_BASE_URL,
    natsUrl: parsed.NATS_URL,
    stripeKey: parsed.STRIPE_KEY,
    stream: parsed.PAYMENTS_STREAM ?? PAYMENTS_STREAM,
    logLevel: parsed.LOG_LEVEL ?? "info",
  };
}

const fallbackLogger = createLogger({ name: "payments" });

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger({ name: "payments", level: env.logLevel });

  const db = createDbClient("payments", env.databaseUrl, { schema: paymentsTables });
  const authClient = createHttpAuthSessionClient(env.authBaseUrl);
  const stripe = new Stripe(env.stripeKey);
  const paymentIntentClient = createStripePaymentIntentClient(stripe);

  const nats = await connect({ servers: env.natsUrl });
  const publisher = createPublisher(nats, { logger });
  const relay = startOutboxRelay(db.db, paymentsOutbox, publisher.publish, { logger });

  const orderCreatedConsumer = await startPaymentsOrderCreatedConsumer({
    db,
    nats,
    stream: env.stream,
    logger,
  });

  const orderCancelledConsumer = await startPaymentsOrderCancelledConsumer({
    db,
    nats,
    stream: env.stream,
    logger,
  });

  const app = createPaymentsApp({ db, authClient, paymentIntentClient, logger });

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
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
    await orderCancelledConsumer.stop();
    await orderCreatedConsumer.stop();
    await relay.stop();
    await nats.close();
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
