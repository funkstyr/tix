import { connect } from "@nats-io/transport-node";

import { ORDERS_STREAM } from "@tix/contracts/subjects";
import { createDbClient } from "@tix/db-core/client";
import { createLogger } from "@tix/observability/logger";

import { expirationTables } from "./expiration-schema.ts";
import { startExpirationService } from "./expiration-service.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);

  return value;
}

function parseRedisUrl(raw: string): { host: string; port: number } {
  const url = new URL(raw);
  if (!url.hostname) throw new Error(`REDIS_URL missing host: ${raw}`);

  const port = url.port ? Number(url.port) : 6379;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid REDIS_URL port: ${raw}`);
  }

  return { host: url.hostname, port };
}

async function main(): Promise<void> {
  const logger = createLogger({ name: "expiration", level: process.env["LOG_LEVEL"] ?? "info" });

  const databaseUrl = requireEnv("DATABASE_URL");
  const natsUrl = requireEnv("NATS_URL");
  const redisUrl = requireEnv("REDIS_URL");
  const stream = process.env["EXPIRATION_STREAM"] ?? ORDERS_STREAM;

  const db = createDbClient("expiration", databaseUrl, { schema: expirationTables });
  const nats = await connect({ servers: natsUrl });
  const redis = parseRedisUrl(redisUrl);

  const service = await startExpirationService({ db, nats, stream, redis, logger });
  logger.info({ stream, queue: "expiration" }, "expiration service started");

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
  createLogger({ name: "expiration" }).fatal({ err }, "expiration service failed to start");
  process.exit(1);
});
