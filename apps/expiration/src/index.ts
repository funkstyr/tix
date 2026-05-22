import { connect } from "@nats-io/transport-node";
import { ArkErrors, type } from "arktype";
import type { Level } from "pino";

import { ORDERS_STREAM } from "@tix/contracts/subjects";
import { createDbClient } from "@tix/db-core/client";
import { createLogger } from "@tix/observability/logger";

import { expirationTables } from "./expiration-schema.ts";
import { startExpirationService } from "./expiration-service.ts";

const envSchema = type({
  DATABASE_URL: "string > 0",
  NATS_URL: "string > 0",
  REDIS_URL: "string > 0",
  "EXPIRATION_STREAM?": "string > 0",
  "LOG_LEVEL?": "'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'",
});

type Env = {
  databaseUrl: string;
  natsUrl: string;
  redis: { host: string; port: number };
  stream: string;
  logLevel: Level;
};

function parseRedisUrl(raw: string): { host: string; port: number } {
  const url = new URL(raw);
  if (!url.hostname) throw new Error(`REDIS_URL missing host: ${raw}`);

  const port = url.port ? Number(url.port) : 6379;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid REDIS_URL port: ${raw}`);
  }

  return { host: url.hostname, port };
}

function parseEnv(): Env {
  const parsed = envSchema(process.env);
  if (parsed instanceof ArkErrors) {
    throw new Error(`invalid environment: ${parsed.summary}`);
  }

  return {
    databaseUrl: parsed.DATABASE_URL,
    natsUrl: parsed.NATS_URL,
    redis: parseRedisUrl(parsed.REDIS_URL),
    stream: parsed.EXPIRATION_STREAM ?? ORDERS_STREAM,
    logLevel: parsed.LOG_LEVEL ?? "info",
  };
}

const fallbackLogger = createLogger({ name: "expiration" });

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger({ name: "expiration", level: env.logLevel });

  const db = createDbClient("expiration", env.databaseUrl, { schema: expirationTables });
  const nats = await connect({ servers: env.natsUrl });

  const service = await startExpirationService({
    db,
    nats,
    stream: env.stream,
    redis: env.redis,
    logger,
  });
  logger.info({ stream: env.stream, queue: "expiration" }, "expiration service started");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "shutting down expiration service");
    await service.stop();
    await nats.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  fallbackLogger.fatal({ err }, "expiration service failed to start");
  process.exit(1);
});
