import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ORDER_CREATED_V1 } from "@tix/contracts/subjects";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher, type RunningConsumer } from "@tix/messaging/jetstream";
import { dockerAvailable } from "@tix/test-helpers/docker-available";
import { requireValue } from "@tix/test-helpers/require-value";
import { waitFor } from "@tix/test-helpers/wait-for";

import { startPaymentsOrderCreatedConsumer } from "./payments-consumer.ts";
import {
  orderReadModel as orderReadModelTable,
  paymentsInbox as paymentsInboxTable,
  paymentsTables,
} from "./payments-schema.ts";

const paymentsMigrations = fileURLToPath(new URL("../drizzle", import.meta.url));

type PaymentsDbClient = DbClient<typeof paymentsTables>;

let pgContainer: StartedTestContainer | undefined;
let natsContainer: StartedTestContainer | undefined;
let nats: NatsConnection | undefined;
let paymentsDb: PaymentsDbClient | undefined;
let streamName: string | undefined;
let consumer: RunningConsumer | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "payments_order_created_e2e",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/payments_order_created_e2e`;
  paymentsDb = createDbClient("payments", pgUrl, { schema: paymentsTables });
  await migrate(paymentsDb.db, { migrationsFolder: paymentsMigrations });

  const natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;
  nats = await connect({ servers: natsUrl });
}, 180_000);

afterAll(async () => {
  await nats?.close();
  await paymentsDb?.close();
  await natsContainer?.stop();
  await pgContainer?.stop();
});

beforeEach(async () => {
  if (!dockerAvailable) return;
  const dbRef = requireValue(paymentsDb, "paymentsDb");
  const nc = requireValue(nats, "nats");

  await dbRef.sql`TRUNCATE TABLE payments.order_read_model, payments.outbox, payments.inbox RESTART IDENTITY CASCADE`;

  streamName = `S_${randomUUID().replace(/-/g, "")}`;
  const manager = await jetstreamManager(nc);
  await manager.streams.add({
    name: streamName,
    subjects: [ORDER_CREATED_V1],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
    // Disable publish-side dedupe so the second publish actually reaches the
    // consumer — that's what exercises the inbox-dedupe code path in handler.
    duplicate_window: 0,
  });

  consumer = await startPaymentsOrderCreatedConsumer({
    db: dbRef,
    nats: nc,
    stream: streamName,
  });
});

afterEach(async () => {
  if (!dockerAvailable) return;
  await consumer?.stop();
  consumer = undefined;

  if (nats && streamName) {
    const manager = await jetstreamManager(nats);
    try {
      await manager.streams.delete(streamName);
    } catch {
      // already gone
    }
  }
  streamName = undefined;
});

type PublishOrderCreatedArgs = {
  orderId: string;
  buyerId: string;
  priceCents: number;
  quantity?: number;
  eventId: string;
};

async function publishOrderCreated(args: PublishOrderCreatedArgs): Promise<void> {
  const publisher = createPublisher(requireValue(nats, "nats"));
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 15 * 60 * 1000);

  await publisher.publish(
    ORDER_CREATED_V1,
    {
      orderId: args.orderId,
      ticketId: randomUUID(),
      buyerId: args.buyerId,
      quantity: args.quantity ?? 2,
      priceCents: args.priceCents,
      expiresAt: expiresAt.toISOString(),
      createdAt: createdAt.toISOString(),
    },
    { msgId: args.eventId },
  );
}

async function readReadModel(orderId: string) {
  const [row] = await requireValue(paymentsDb, "paymentsDb")
    .db.select()
    .from(orderReadModelTable)
    .where(eq(orderReadModelTable.id, orderId));

  return row;
}

describe.skipIf(!dockerAvailable)("payments consumer for order.created.v1", () => {
  it("upserts a row into order_read_model with fields from the event", async () => {
    const orderId = randomUUID();
    const buyerId = `buyer-${randomUUID()}`;

    await publishOrderCreated({
      orderId,
      buyerId,
      priceCents: 12_500,
      eventId: randomUUID(),
    });

    const row = await waitFor(() => readReadModel(orderId), 3_000);

    expect(row).toMatchObject({
      id: orderId,
      version: 1,
      userId: buyerId,
      priceCents: 12_500,
      status: "created",
    });
  }, 30_000);

  it("dedupes a redelivered order.created.v1: no duplicate row, single inbox entry", async () => {
    const orderId = randomUUID();
    const buyerId = `buyer-${randomUUID()}`;
    const eventId = randomUUID();

    await publishOrderCreated({ orderId, buyerId, priceCents: 5_000, eventId });
    await waitFor(() => readReadModel(orderId), 3_000);

    await publishOrderCreated({ orderId, buyerId, priceCents: 5_000, eventId });

    const dbRef = requireValue(paymentsDb, "paymentsDb");
    const countRows = async () => {
      const [readModelRows, inboxRows] = await Promise.all([
        dbRef.db.select().from(orderReadModelTable).where(eq(orderReadModelTable.id, orderId)),
        dbRef.db.select().from(paymentsInboxTable).where(eq(paymentsInboxTable.eventId, eventId)),
      ]);
      return { readModel: readModelRows.length, inbox: inboxRows.length };
    };

    // Poll for stability: a (mis)processed redelivery would push either count
    // above 1. Sampling repeatedly is robust against CI scheduling jitter.
    await assertStable(countRows, { readModel: 1, inbox: 1 }, 1_500);
  }, 30_000);
});

async function assertStable<T>(
  read: () => Promise<T>,
  expected: T,
  windowMs: number,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- polling loop by design
    expect(await read()).toEqual(expected);
    // eslint-disable-next-line no-await-in-loop -- polling loop by design
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
