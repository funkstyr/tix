import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ORDER_CANCELLED_V1, ORDER_CREATED_V1 } from "@tix/contracts/subjects";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher, type RunningConsumer } from "@tix/messaging/jetstream";
import { dockerAvailable } from "@tix/test-helpers/docker-available";
import { requireValue } from "@tix/test-helpers/require-value";
import { waitFor } from "@tix/test-helpers/wait-for";

import {
  orderReadModel as orderReadModelTable,
  paymentsInbox as paymentsInboxTable,
  paymentsTables,
} from "../domain/schema.ts";
import { createPaymentsTestRuntime } from "../runtime/test-runtime.ts";
import {
  startPaymentsOrderCancelledConsumer,
  startPaymentsOrderCreatedConsumer,
} from "./order-projection.consumer.ts";

const paymentsMigrations = fileURLToPath(new URL("../../drizzle", import.meta.url));

type PaymentsDbClient = DbClient<typeof paymentsTables>;

let pgContainer: StartedTestContainer | undefined;
let natsContainer: StartedTestContainer | undefined;
let nats: NatsConnection | undefined;
let paymentsDb: PaymentsDbClient | undefined;
let streamName: string | undefined;
let createdConsumer: RunningConsumer | undefined;
let cancelledConsumer: RunningConsumer | undefined;

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
    subjects: [ORDER_CREATED_V1, ORDER_CANCELLED_V1],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
    // Disable publish-side dedupe so the second publish actually reaches the
    // consumer — that's what exercises the inbox-dedupe code path in handler.
    duplicate_window: 0,
  });

  const runtime = createPaymentsTestRuntime({ db: dbRef, nats: nc });
  createdConsumer = await startPaymentsOrderCreatedConsumer({
    runtime,
    nats: nc,
    stream: streamName,
  });

  cancelledConsumer = await startPaymentsOrderCancelledConsumer({
    runtime,
    nats: nc,
    stream: streamName,
  });
});

afterEach(async () => {
  if (!dockerAvailable) return;
  await cancelledConsumer?.stop();
  cancelledConsumer = undefined;
  await createdConsumer?.stop();
  createdConsumer = undefined;

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

type PublishOrderCancelledArgs = {
  orderId: string;
  version: number;
  eventId: string;
};

async function publishOrderCancelled(args: PublishOrderCancelledArgs): Promise<void> {
  const publisher = createPublisher(requireValue(nats, "nats"));

  await publisher.publish(
    ORDER_CANCELLED_V1,
    {
      orderId: args.orderId,
      version: args.version,
      cancelledAt: new Date().toISOString(),
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

describe.skipIf(!dockerAvailable)("payments consumer for order.cancelled.v1", () => {
  it("marks the read-model row cancelled when event version === local version + 1", async () => {
    const orderId = randomUUID();
    const buyerId = `buyer-${randomUUID()}`;

    await publishOrderCreated({ orderId, buyerId, priceCents: 7_500, eventId: randomUUID() });
    await waitFor(() => readReadModel(orderId), 3_000);

    await publishOrderCancelled({ orderId, version: 2, eventId: randomUUID() });

    const row = await waitFor(async () => {
      const r = await readReadModel(orderId);
      return r?.status === "cancelled" ? r : undefined;
    }, 3_000);

    expect(row).toMatchObject({
      id: orderId,
      version: 2,
      status: "cancelled",
    });
  }, 30_000);

  it("ignores a stale event when event version <= local version", async () => {
    const orderId = randomUUID();
    const buyerId = `buyer-${randomUUID()}`;

    await publishOrderCreated({ orderId, buyerId, priceCents: 9_000, eventId: randomUUID() });
    await waitFor(() => readReadModel(orderId), 3_000);

    // event.version = 1 equals local version → fails the WHERE version = 0 check
    // inside updateVersioned, so the row stays at version 1 / status "created".
    await publishOrderCancelled({ orderId, version: 1, eventId: randomUUID() });

    const projection = async () => {
      const row = await readReadModel(orderId);
      return { version: row?.version, status: row?.status };
    };

    await assertStable(projection, { version: 1, status: "created" }, 1_500);
  }, 30_000);

  it("dedupes a redelivered order.cancelled.v1: row updated once, single inbox entry", async () => {
    const orderId = randomUUID();
    const buyerId = `buyer-${randomUUID()}`;
    const cancelEventId = randomUUID();

    await publishOrderCreated({ orderId, buyerId, priceCents: 4_000, eventId: randomUUID() });
    await waitFor(() => readReadModel(orderId), 3_000);

    await publishOrderCancelled({ orderId, version: 2, eventId: cancelEventId });
    await waitFor(async () => {
      const r = await readReadModel(orderId);
      return r?.status === "cancelled" ? r : undefined;
    }, 3_000);

    // Redeliver the same event. If it weren't deduped, updateVersioned would
    // miss (local already at v2) — but we also want to assert the inbox stays
    // at one row, which proves the dedupe guard fired before the update.
    await publishOrderCancelled({ orderId, version: 2, eventId: cancelEventId });

    const dbRef = requireValue(paymentsDb, "paymentsDb");
    const snapshot = async () => {
      const [readModelRows, inboxRows] = await Promise.all([
        dbRef.db.select().from(orderReadModelTable).where(eq(orderReadModelTable.id, orderId)),
        dbRef.db
          .select()
          .from(paymentsInboxTable)
          .where(eq(paymentsInboxTable.eventId, cancelEventId)),
      ]);
      return {
        readModel: readModelRows.length,
        rowVersion: readModelRows[0]?.version,
        rowStatus: readModelRows[0]?.status,
        inbox: inboxRows.length,
      };
    };

    await assertStable(
      snapshot,
      { readModel: 1, rowVersion: 2, rowStatus: "cancelled", inbox: 1 },
      1_500,
    );
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
