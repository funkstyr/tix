import { jetstreamManager, type PubAck, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Queue, type ConnectionOptions } from "bullmq";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { orderExpiredV1, type OrderExpiredV1 } from "@tix/contracts/orders";
import { ORDER_CREATED_V1, ORDER_EXPIRED_V1 } from "@tix/contracts/subjects";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createConsumer, createPublisher, type Publisher } from "@tix/messaging/jetstream";

import { expirationInbox, expirationTables } from "./expiration-schema.ts";
import {
  EXPIRATION_JOB_NAME,
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

// BullMQ + ioredis emit a `Connection is closed.` rejection when the worker's
// blocking BRPOPLPUSH resolves after `worker.close()`. It's harmless shutdown
// noise (no command is retried — `maxRetriesPerRequest: null` is set), but it
// reaches Node's unhandledRejection handler and fails the vitest run. Filter
// only this exact message; re-emit anything else.
const swallowBullMqShutdownNoise = (reason: unknown): void => {
  if (reason instanceof Error && reason.message === "Connection is closed.") return;
  throw reason;
};

beforeAll(async () => {
  process.on("unhandledRejection", swallowBullMqShutdownNoise);

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
  process.off("unhandledRejection", swallowBullMqShutdownNoise);
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
  streamName = `S_${randomUUID().replace(/-/g, "")}`;
  const harness = requireHarness();

  await harness.db.sql`TRUNCATE TABLE expiration.inbox RESTART IDENTITY CASCADE`;

  const purgeQueue = new Queue(EXPIRATION_QUEUE, { connection: harness.redis });
  try {
    await purgeQueue.obliterate({ force: true });
  } finally {
    await purgeQueue.close();
  }

  const manager = await jetstreamManager(harness.nats);
  await manager.streams.add({
    name: harness.stream,
    subjects: [ORDER_CREATED_V1, ORDER_EXPIRED_V1],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
  });

  service = await startExpirationService({
    db: harness.db,
    nats: harness.nats,
    stream: harness.stream,
    redis: harness.redis,
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

async function publishOrderCreated(
  nc: NatsConnection,
  args: PublishArgs,
): Promise<{ expiresAt: string }> {
  const publisher = createPublisher(nc);
  const expiresAt = new Date(Date.now() + args.expiresInMs).toISOString();
  const payload = {
    orderId: args.orderId,
    ticketId: randomUUID(),
    buyerId: `user-${randomUUID()}`,
    quantity: 1,
    priceCents: 5_000,
    expiresAt,
    createdAt: new Date().toISOString(),
  };
  await publisher.publish(ORDER_CREATED_V1, payload, { msgId: args.eventId });
  return { expiresAt };
}

async function waitForJob(
  queue: Queue<ExpireOrderPayload, void>,
  jobId: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const job = await queue.getJob(jobId);
    if (job) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${jobId} did not appear within ${timeoutMs}ms`);
}

type ExpiredEnvelope = { payload: OrderExpiredV1; eventId: string };

async function awaitExpiredEvent(
  nc: NatsConnection,
  stream: string,
  expectedOrderId: string,
): Promise<ExpiredEnvelope> {
  let resolveEvent!: (e: ExpiredEnvelope) => void;
  const received = new Promise<ExpiredEnvelope>((r) => {
    resolveEvent = r;
  });

  const consumer = await createConsumer(nc, {
    stream,
    subjectFilter: ORDER_EXPIRED_V1,
    group: `test-expired-${randomUUID()}`,
    schema: orderExpiredV1,
    handler: ({ payload, eventId }) => {
      if (payload.orderId === expectedOrderId) {
        resolveEvent({ payload, eventId });
      }
    },
  });

  try {
    return await received;
  } finally {
    await consumer.stop();
  }
}

describe.skipIf(!dockerAvailable)("expiration consumer", () => {
  it("schedules a BullMQ delayed job with jobId=orderId within 1s of order.created.v1", async () => {
    const { nats: nc, redis: redisRef } = requireHarness();
    const orderId = randomUUID();

    const queue = new Queue<ExpireOrderPayload, void>(EXPIRATION_QUEUE, { connection: redisRef });
    try {
      const { expiresAt } = await publishOrderCreated(nc, {
        eventId: randomUUID(),
        orderId,
        expiresInMs: 500,
      });

      await waitForJob(queue, orderId, 1_000);

      const job = await queue.getJob(orderId);
      expect(job).toBeTruthy();
      expect(job?.id).toBe(orderId);
      expect(job?.data).toEqual({ orderId, expiredAt: expiresAt });
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
      const { expiresAt: expiresA } = await publishOrderCreated(nc, {
        eventId: randomUUID(),
        orderId: orderA,
        expiresInMs: 5_000,
      });
      const { expiresAt: expiresB } = await publishOrderCreated(nc, {
        eventId: randomUUID(),
        orderId: orderB,
        expiresInMs: 5_000,
      });

      await waitForJob(queue, orderA, 2_000);
      await waitForJob(queue, orderB, 2_000);

      const jobA = await queue.getJob(orderA);
      const jobB = await queue.getJob(orderB);
      expect(jobA?.data).toEqual({ orderId: orderA, expiredAt: expiresA });
      expect(jobB?.data).toEqual({ orderId: orderB, expiredAt: expiresB });

      const inboxRows = await dbRef.db.select().from(expirationInbox);
      expect(inboxRows).toHaveLength(2);
    } finally {
      await queue.close();
    }
  }, 30_000);
});

describe.skipIf(!dockerAvailable)("expiration worker", () => {
  it("publishes a schema-valid order.expired.v1 after the scheduled delay", async () => {
    const { nats: nc, stream } = requireHarness();
    if (!service) throw new Error("service not started");

    const orderId = randomUUID();
    const expiredAt = new Date(Date.now() + 200).toISOString();
    const scheduledAt = Date.now();
    await service.scheduler.scheduleDelayed(
      EXPIRATION_JOB_NAME,
      { orderId, expiredAt },
      200,
      orderId,
    );

    const { payload } = await awaitExpiredEvent(nc, stream, orderId);
    const elapsed = Date.now() - scheduledAt;

    expect(() => orderExpiredV1.assert(payload)).not.toThrow();
    expect(payload).toEqual({ orderId, expiredAt });
    expect(elapsed).toBeGreaterThanOrEqual(200);
  }, 30_000);

  it("dedupes via JetStream msgId when a publish ack is lost and BullMQ retries", async () => {
    const { db: dbRef, nats: nc, redis: redisRef, stream } = requireHarness();

    // Tear down the auto-started service so we can inject a publisher that simulates
    // a lost ack: the first publish reaches JetStream successfully, but the handler
    // throws afterward — forcing a BullMQ retry that should be dedup'd server-side.
    await service?.stop();

    const realPublisher = createPublisher(nc);
    const acks: PubAck[] = [];
    let attempts = 0;
    const lossyPublisher: Publisher = {
      publish: async (subject, payload, opts) => {
        attempts++;
        const result = await realPublisher.publish(subject, payload, opts);
        acks.push(result.ack);
        if (attempts === 1) throw new Error("simulated lost ack after successful publish");
        return result;
      },
    };

    service = await startExpirationService({
      db: dbRef,
      nats: nc,
      stream,
      redis: redisRef,
      publisher: lossyPublisher,
    });

    // Resolve once BullMQ has marked the retried job completed; without waiting
    // for this, tearing the worker down while the completion write is in flight
    // surfaces an ioredis "Connection is closed" unhandled rejection.
    const retryCompleted = new Promise<void>((resolve) => {
      service?.worker.once("completed", () => resolve());
    });

    const orderId = randomUUID();
    const expiredAt = new Date(Date.now() + 50).toISOString();
    await service.scheduler.scheduleDelayed(
      EXPIRATION_JOB_NAME,
      { orderId, expiredAt },
      50,
      orderId,
    );

    const { payload } = await awaitExpiredEvent(nc, stream, orderId);

    expect(payload).toEqual({ orderId, expiredAt });

    await retryCompleted;

    expect(acks).toHaveLength(2);
    expect(acks[0]?.duplicate).toBe(false);
    expect(acks[1]?.duplicate).toBe(true);
  }, 30_000);

  it("leaves no delayed or waiting jobs after a successful fire", async () => {
    const { nats: nc, redis: redisRef, stream } = requireHarness();
    if (!service) throw new Error("service not started");

    const orderId = randomUUID();
    const expiredAt = new Date(Date.now() + 100).toISOString();
    await service.scheduler.scheduleDelayed(
      EXPIRATION_JOB_NAME,
      { orderId, expiredAt },
      100,
      orderId,
    );

    await awaitExpiredEvent(nc, stream, orderId);

    const queue = new Queue<ExpireOrderPayload, void>(EXPIRATION_QUEUE, { connection: redisRef });
    try {
      const counts = await queue.getJobCounts("delayed", "waiting", "active");
      expect(counts["delayed"] ?? 0).toBe(0);
      expect(counts["waiting"] ?? 0).toBe(0);
      expect(counts["active"] ?? 0).toBe(0);
    } finally {
      await queue.close();
    }
  }, 30_000);
});
