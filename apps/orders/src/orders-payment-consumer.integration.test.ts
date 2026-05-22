import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type PaymentCreatedV1 } from "@tix/contracts/payments";
import { PAYMENT_CREATED_V1 } from "@tix/contracts/subjects";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher, type RunningConsumer } from "@tix/messaging/jetstream";
import { dockerAvailable } from "@tix/test-helpers/docker-available";
import { requireValue } from "@tix/test-helpers/require-value";
import { waitFor } from "@tix/test-helpers/wait-for";

import { startOrdersPaymentCreatedConsumer } from "./orders-payment-consumer.ts";
import {
  orders as ordersTable,
  ordersInbox as ordersInboxTable,
  ordersTables,
} from "./orders-schema.ts";

const ordersMigrations = fileURLToPath(new URL("../drizzle", import.meta.url));

type OrdersDbClient = DbClient<typeof ordersTables>;

let pgContainer: StartedTestContainer | undefined;
let natsContainer: StartedTestContainer | undefined;
let nats: NatsConnection | undefined;
let ordersDb: OrdersDbClient | undefined;
let streamName: string | undefined;
let consumer: RunningConsumer | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "orders_payment_e2e",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/orders_payment_e2e`;
  ordersDb = createDbClient("orders", pgUrl, { schema: ordersTables });
  await migrate(ordersDb.db, { migrationsFolder: ordersMigrations });

  const natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;
  nats = await connect({ servers: natsUrl });
}, 180_000);

afterAll(async () => {
  await nats?.close();
  await ordersDb?.close();
  await natsContainer?.stop();
  await pgContainer?.stop();
});

beforeEach(async () => {
  if (!dockerAvailable) return;
  const dbRef = requireValue(ordersDb, "ordersDb");
  const nc = requireValue(nats, "nats");

  await dbRef.sql`TRUNCATE TABLE orders.orders, orders.outbox, orders.inbox RESTART IDENTITY CASCADE`;

  streamName = `S_${randomUUID().replace(/-/g, "")}`;
  const manager = await jetstreamManager(nc);
  await manager.streams.add({
    name: streamName,
    subjects: [PAYMENT_CREATED_V1],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
    // Disable publish-side dedupe so a second publish actually reaches the
    // consumer — that's what exercises the inbox-dedupe code path in handler.
    duplicate_window: 0,
  });

  consumer = await startOrdersPaymentCreatedConsumer({
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

async function seedOrder(status: "created" | "expired" = "created"): Promise<{ id: string }> {
  const dbRef = requireValue(ordersDb, "ordersDb");
  const id = randomUUID();

  await dbRef.db.insert(ordersTable).values({
    id,
    buyerId: `buyer-${randomUUID()}`,
    ticketId: randomUUID(),
    quantity: 1,
    status,
    expiresAt: new Date(Date.now() + 60_000),
  });

  return { id };
}

async function publishPaymentCreated(args: { orderId: string; eventId: string }): Promise<void> {
  const publisher = createPublisher(requireValue(nats, "nats"));
  const payload: PaymentCreatedV1 = {
    id: randomUUID(),
    orderId: args.orderId,
    stripeId: "pi_test123abc",
    amountCents: 4_500,
    currency: "usd",
    userId: `buyer-${randomUUID()}`,
    version: 1,
    createdAt: new Date().toISOString(),
  };
  await publisher.publish(PAYMENT_CREATED_V1, payload, { msgId: args.eventId });
}

async function readOrder(orderId: string) {
  const dbRef = requireValue(ordersDb, "ordersDb");
  const [row] = await dbRef.db.select().from(ordersTable).where(eq(ordersTable.id, orderId));

  return row;
}

describe.skipIf(!dockerAvailable)("orders consumer for payment.created.v1", () => {
  it("transitions a created Order to complete and bumps version", async () => {
    const seeded = await seedOrder();

    await publishPaymentCreated({ orderId: seeded.id, eventId: randomUUID() });

    const completed = await waitFor(async () => {
      const row = await readOrder(seeded.id);

      return row?.status === "complete" ? row : undefined;
    }, 3_000);

    expect(completed.status).toBe("complete");
    expect(completed.version).toBe(2);
  }, 30_000);

  it("dedupes a redelivered payment.created.v1: order unchanged on second receipt", async () => {
    const seeded = await seedOrder();
    const eventId = randomUUID();

    await publishPaymentCreated({ orderId: seeded.id, eventId });
    await waitFor(async () => {
      const row = await readOrder(seeded.id);

      return row?.status === "complete" ? row : undefined;
    }, 3_000);

    await publishPaymentCreated({ orderId: seeded.id, eventId });
    // Give the consumer a chance to (mis)process the redelivery.
    await new Promise((r) => setTimeout(r, 500));

    const row = await readOrder(seeded.id);
    expect(row?.status).toBe("complete");
    expect(row?.version).toBe(2);

    const dbRef = requireValue(ordersDb, "ordersDb");
    const inboxRows = await dbRef.db
      .select()
      .from(ordersInboxTable)
      .where(eq(ordersInboxTable.eventId, eventId));
    expect(inboxRows).toHaveLength(1);
  }, 30_000);

  it("ignores payment.created.v1 for an Order already in a terminal state", async () => {
    const seeded = await seedOrder("expired");

    await publishPaymentCreated({ orderId: seeded.id, eventId: randomUUID() });
    // Let the consumer have a chance to (mis)process the event.
    await new Promise((r) => setTimeout(r, 500));

    const row = await readOrder(seeded.id);
    expect(row?.status).toBe("expired");
    expect(row?.version).toBe(1);
  }, 30_000);
});
