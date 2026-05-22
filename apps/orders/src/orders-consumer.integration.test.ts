import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { orderReservationReleasedV1, type OrderReservationReleasedV1 } from "@tix/contracts/orders";
import { ORDER_EXPIRED_V1, ORDER_RESERVATION_RELEASED_V1 } from "@tix/contracts/subjects";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher, type RunningConsumer } from "@tix/messaging/jetstream";

import { startOrdersExpiredConsumer } from "./orders-consumer.ts";
import {
  orders as ordersTable,
  ordersInbox as ordersInboxTable,
  ordersOutbox as ordersOutboxTable,
  ordersTables,
} from "./orders-schema.ts";

const ordersMigrations = fileURLToPath(new URL("../drizzle", import.meta.url));

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
      POSTGRES_DB: "orders_expired_e2e",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/orders_expired_e2e`;
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
  const dbRef = requireDb();
  const nc = requireNats();

  await dbRef.sql`TRUNCATE TABLE orders.orders, orders.outbox, orders.inbox RESTART IDENTITY CASCADE`;

  streamName = `S_${randomUUID().replace(/-/g, "")}`;
  const manager = await jetstreamManager(nc);
  await manager.streams.add({
    name: streamName,
    subjects: [ORDER_EXPIRED_V1, ORDER_RESERVATION_RELEASED_V1],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
    // Disable publish-side dedupe so the second publish actually reaches the
    // consumer — that's what exercises the inbox-dedupe code path in handler.
    duplicate_window: 0,
  });

  consumer = await startOrdersExpiredConsumer({
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

function requireDb(): OrdersDbClient {
  if (!ordersDb) throw new Error("ordersDb not initialized");
  return ordersDb;
}

function requireNats(): NatsConnection {
  if (!nats) throw new Error("nats not initialized");
  return nats;
}

type SeedOrderArgs = { quantity?: number; status?: string };

async function seedOrder(args: SeedOrderArgs = {}): Promise<{
  id: string;
  ticketId: string;
  quantity: number;
}> {
  const dbRef = requireDb();
  const id = randomUUID();
  const ticketId = randomUUID();
  const quantity = args.quantity ?? 2;

  await dbRef.db.insert(ordersTable).values({
    id,
    buyerId: `buyer-${randomUUID()}`,
    ticketId,
    quantity,
    status: args.status ?? "created",
    expiresAt: new Date(Date.now() - 1_000),
  });

  return { id, ticketId, quantity };
}

async function publishExpired(args: { orderId: string; eventId: string }): Promise<void> {
  const publisher = createPublisher(requireNats());
  await publisher.publish(
    ORDER_EXPIRED_V1,
    { orderId: args.orderId, expiredAt: new Date().toISOString() },
    { msgId: args.eventId },
  );
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const value = await read();
    if (value !== undefined) return value;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not satisfied within ${timeoutMs}ms`);
}

async function readReleasedFromOutbox(
  orderId: string,
): Promise<OrderReservationReleasedV1 | undefined> {
  const rows = await requireDb()
    .db.select()
    .from(ordersOutboxTable)
    .where(eq(ordersOutboxTable.subject, ORDER_RESERVATION_RELEASED_V1));

  for (const row of rows) {
    const payload = row.payload as OrderReservationReleasedV1;
    if (payload.orderId === orderId) return payload;
  }

  return undefined;
}

describe.skipIf(!dockerAvailable)("orders consumer for order.expired.v1", () => {
  it("transitions the Order to expired, bumps version, and enqueues a release event", async () => {
    const seeded = await seedOrder();

    await publishExpired({ orderId: seeded.id, eventId: randomUUID() });

    const released = await waitFor(() => readReleasedFromOutbox(seeded.id), 3_000);

    expect(released).toMatchObject({
      orderId: seeded.id,
      ticketId: seeded.ticketId,
      quantity: seeded.quantity,
    });
    expect(() => orderReservationReleasedV1.assert(released)).not.toThrow();

    const [row] = await requireDb()
      .db.select()
      .from(ordersTable)
      .where(eq(ordersTable.id, seeded.id));
    expect(row?.status).toBe("expired");
    expect(row?.version).toBe(2);
  }, 30_000);

  it("dedupes a redelivered order.expired.v1: order unchanged, no second release", async () => {
    const seeded = await seedOrder();
    const eventId = randomUUID();

    await publishExpired({ orderId: seeded.id, eventId });
    await waitFor(() => readReleasedFromOutbox(seeded.id), 3_000);

    await publishExpired({ orderId: seeded.id, eventId });
    // Let the consumer have a chance to (mis)process the redelivery.
    await new Promise((r) => setTimeout(r, 500));

    const dbRef = requireDb();

    const releaseRows = await dbRef.db
      .select()
      .from(ordersOutboxTable)
      .where(eq(ordersOutboxTable.subject, ORDER_RESERVATION_RELEASED_V1));
    expect(releaseRows).toHaveLength(1);

    const inboxRows = await dbRef.db
      .select()
      .from(ordersInboxTable)
      .where(eq(ordersInboxTable.eventId, eventId));
    expect(inboxRows).toHaveLength(1);

    const [row] = await dbRef.db.select().from(ordersTable).where(eq(ordersTable.id, seeded.id));
    expect(row?.status).toBe("expired");
    expect(row?.version).toBe(2);
  }, 30_000);
});
