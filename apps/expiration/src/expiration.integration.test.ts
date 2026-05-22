import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Queue, type ConnectionOptions } from "bullmq";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ORDER_CREATED_V1 } from "@tix/contracts/subjects";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher } from "@tix/messaging/jetstream";

import { expirationInbox, expirationTables } from "./expiration-schema.ts";
import {
  EXPIRATION_QUEUE,
  startExpirationService,
  type ExpireOrderPayload,
  type RunningExpirationService,
} from "./expiration-service.ts";

const expirationMigrations = fileURLToPath(new URL("../drizzle", import.meta.url));

const dockerAvailable = ((): boolean => {
  if (process.env["DOCKER_HOST"]) return true;
  const home = process.env["HOME"] ?? "";
  const candidates = [
    "/var/run/docker.sock",
    `${home}/.docker/run/docker.sock`,
    `${home}/.colima/default/docker.sock`,
    `${home}/.orbstack/run/docker.sock`,
  ];
  return candidates.some((p) => existsSync(p));
})();

type ExpirationDbClient = DbClient<typeof expirationTables>;

let pgContainer: StartedTestContainer | undefined;
let natsContainer: StartedTestContainer | undefined;
let redisContainer: StartedTestContainer | undefined;
let nats: NatsConnection | undefined;
let db: ExpirationDbClient | undefined;
let redis: ConnectionOptions | undefined;
let service: RunningExpirationService | undefined;
let streamName: string | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "expiration_e2e",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  redisContainer = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/expiration_e2e`;
  db = createDbClient("expiration", pgUrl, { schema: expirationTables });
  await migrate(db.db, { migrationsFolder: expirationMigrations });

  const natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;
  nats = await connect({ servers: natsUrl });

  redis = { host: redisContainer.getHost(), port: redisContainer.getMappedPort(6379) };
}, 180_000);

afterAll(async () => {
  await nats?.close();
  await db?.close();
  await natsContainer?.stop();
  await redisContainer?.stop();
  await pgContainer?.stop();
});

function requireHarness(): {
  db: ExpirationDbClient;
  nats: NatsConnection;
  redis: ConnectionOptions;
  stream: string;
} {
  if (!db || !nats || !redis || !streamName) throw new Error("test harness not initialized");
  return { db, nats, redis, stream: streamName };
}

beforeEach(async () => {
  if (!dockerAvailable) return;
  const {
    db: dbRef,
    nats: natsRef,
    redis: redisRef,
  } = {
    db: db!,
    nats: nats!,
    redis: redis!,
  };

  await dbRef.sql`TRUNCATE TABLE expiration.inbox RESTART IDENTITY CASCADE`;

  const purgeQueue = new Queue(EXPIRATION_QUEUE, { connection: redisRef });
  try {
    await purgeQueue.obliterate({ force: true });
  } finally {
    await purgeQueue.close();
  }

  streamName = `S_${randomUUID().replace(/-/g, "")}`;
  const manager = await jetstreamManager(natsRef);
  await manager.streams.add({
    name: streamName,
    subjects: [ORDER_CREATED_V1],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
  });

  service = await startExpirationService({
    db: dbRef,
    nats: natsRef,
    stream: streamName,
    redis: redisRef,
  });
});

afterEach(async () => {
  if (!dockerAvailable) return;
  await service?.stop();
  service = undefined;

  if (nats && streamName) {
    const manager = await jetstreamManager(nats);
    try {
      await manager.streams.delete(streamName);
    } catch {
      // stream may already be gone if a test cleaned up
    }
  }
  streamName = undefined;
});

type PublishArgs = {
  eventId: string;
  orderId: string;
  expiresInMs: number;
};

async function publishOrderCreated(nc: NatsConnection, args: PublishArgs): Promise<void> {
  const publisher = createPublisher(nc);
  const payload = {
    orderId: args.orderId,
    ticketId: randomUUID(),
    buyerId: `user-${randomUUID()}`,
    quantity: 1,
    expiresAt: new Date(Date.now() + args.expiresInMs).toISOString(),
    createdAt: new Date().toISOString(),
  };
  await publisher.publish(ORDER_CREATED_V1, payload, { msgId: args.eventId });
}

async function waitForJob(
  queue: Queue<ExpireOrderPayload, void>,
  jobId: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  // eslint-disable-next-line no-await-in-loop
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const job = await queue.getJob(jobId);
    if (job) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${jobId} did not appear within ${timeoutMs}ms`);
}

describe.skipIf(!dockerAvailable)("expiration consumer", () => {
  it("schedules a BullMQ delayed job with jobId=orderId within 1s of order.created.v1", async () => {
    const { nats: nc, redis: redisRef } = requireHarness();
    const orderId = randomUUID();

    const queue = new Queue<ExpireOrderPayload, void>(EXPIRATION_QUEUE, { connection: redisRef });
    try {
      await publishOrderCreated(nc, {
        eventId: randomUUID(),
        orderId,
        expiresInMs: 500,
      });

      await waitForJob(queue, orderId, 1_000);

      const job = await queue.getJob(orderId);
      expect(job).toBeTruthy();
      expect(job?.id).toBe(orderId);
      expect(job?.data).toEqual({ orderId });
    } finally {
      await queue.close();
    }
  }, 30_000);

  it("schedules exactly one job when the same eventId is published twice", async () => {
    const { db: dbRef, nats: nc, redis: redisRef } = requireHarness();
    const eventId = randomUUID();
    const orderId = randomUUID();

    const queue = new Queue<ExpireOrderPayload, void>(EXPIRATION_QUEUE, { connection: redisRef });
    try {
      await publishOrderCreated(nc, { eventId, orderId, expiresInMs: 5_000 });
      await publishOrderCreated(nc, { eventId, orderId, expiresInMs: 5_000 });

      await waitForJob(queue, orderId, 2_000);

      // Wait one more cycle so the consumer has a chance to (mis)handle the duplicate.
      await new Promise((r) => setTimeout(r, 500));

      const counts = await queue.getJobCounts("delayed", "active", "waiting", "completed");
      const total =
        (counts["delayed"] ?? 0) +
        (counts["active"] ?? 0) +
        (counts["waiting"] ?? 0) +
        (counts["completed"] ?? 0);
      expect(total).toBe(1);

      const inboxRows = await dbRef.db.select().from(expirationInbox);
      expect(inboxRows).toHaveLength(1);
      expect(inboxRows[0]?.eventId).toBe(eventId);
    } finally {
      await queue.close();
    }
  }, 30_000);

  it("schedules two distinct jobs for two distinct orders", async () => {
    const { db: dbRef, nats: nc, redis: redisRef } = requireHarness();
    const orderA = randomUUID();
    const orderB = randomUUID();

    const queue = new Queue<ExpireOrderPayload, void>(EXPIRATION_QUEUE, { connection: redisRef });
    try {
      await publishOrderCreated(nc, {
        eventId: randomUUID(),
        orderId: orderA,
        expiresInMs: 5_000,
      });
      await publishOrderCreated(nc, {
        eventId: randomUUID(),
        orderId: orderB,
        expiresInMs: 5_000,
      });

      await waitForJob(queue, orderA, 2_000);
      await waitForJob(queue, orderB, 2_000);

      const jobA = await queue.getJob(orderA);
      const jobB = await queue.getJob(orderB);
      expect(jobA?.data).toEqual({ orderId: orderA });
      expect(jobB?.data).toEqual({ orderId: orderB });

      const inboxRows = await dbRef.db.select().from(expirationInbox);
      expect(inboxRows).toHaveLength(2);
    } finally {
      await queue.close();
    }
  }, 30_000);
});
