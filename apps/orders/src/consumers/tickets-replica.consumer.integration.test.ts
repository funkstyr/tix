import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TICKETS_CREATED_V1, TICKETS_UPDATED_V1 } from "@tix/contracts/subjects";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher, type RunningConsumer } from "@tix/messaging/jetstream";
import { dockerAvailable } from "@tix/test-helpers/docker-available";
import { requireValue } from "@tix/test-helpers/require-value";
import { waitFor } from "@tix/test-helpers/wait-for";

import { ticketsReplica, ordersTables } from "../domain/schema.ts";
import { createOrdersTestRuntime } from "../runtime/test-runtime.ts";
import {
  startTicketsCreatedConsumer,
  startTicketsUpdatedConsumer,
} from "./tickets-replica.consumer.ts";

const ordersMigrations = fileURLToPath(new URL("../../drizzle", import.meta.url));

type OrdersDbClient = DbClient<typeof ordersTables>;

let pgContainer: StartedTestContainer | undefined;
let natsContainer: StartedTestContainer | undefined;
let nats: NatsConnection | undefined;
let ordersDb: OrdersDbClient | undefined;
let streamName: string | undefined;
let createdConsumer: RunningConsumer | undefined;
let updatedConsumer: RunningConsumer | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "orders_replica_e2e",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/orders_replica_e2e`;
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

  await dbRef.sql`TRUNCATE TABLE orders.tickets_replica, orders.inbox RESTART IDENTITY CASCADE`;

  streamName = `S_${randomUUID().replace(/-/g, "")}`;
  const manager = await jetstreamManager(nc);
  await manager.streams.add({
    name: streamName,
    subjects: [TICKETS_CREATED_V1, TICKETS_UPDATED_V1],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
    duplicate_window: 0,
  });

  const runtime = createOrdersTestRuntime({ db: dbRef, nats: nc });
  createdConsumer = await startTicketsCreatedConsumer({ runtime, nats: nc, stream: streamName });
  updatedConsumer = await startTicketsUpdatedConsumer({ runtime, nats: nc, stream: streamName });
});

afterEach(async () => {
  if (!dockerAvailable) return;
  await updatedConsumer?.stop();
  await createdConsumer?.stop();
  updatedConsumer = undefined;
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

async function publishCreated(ticketId: string): Promise<void> {
  const publisher = createPublisher(requireValue(nats, "nats"));
  await publisher.publish(
    TICKETS_CREATED_V1,
    {
      ticketId,
      sellerId: `seller-${randomUUID()}`,
      title: "Original title",
      quantityTotal: 10,
      unitPriceCents: 4500,
      createdAt: new Date().toISOString(),
    },
    { msgId: randomUUID() },
  );
}

async function publishUpdated(args: {
  ticketId: string;
  title: string;
  unitPriceCents: number;
  version: number;
}): Promise<void> {
  const publisher = createPublisher(requireValue(nats, "nats"));
  await publisher.publish(
    TICKETS_UPDATED_V1,
    {
      ticketId: args.ticketId,
      sellerId: `seller-${randomUUID()}`,
      title: args.title,
      unitPriceCents: args.unitPriceCents,
      version: args.version,
      updatedAt: new Date().toISOString(),
    },
    { msgId: randomUUID() },
  );
}

async function readReplica(
  ticketId: string,
): Promise<typeof ticketsReplica.$inferSelect | undefined> {
  const [row] = await requireValue(ordersDb, "ordersDb")
    .db.select()
    .from(ticketsReplica)
    .where(eq(ticketsReplica.id, ticketId));

  return row;
}

describe.skipIf(!dockerAvailable)("orders tickets replica", () => {
  it("seeds the replica row from tickets.created.v1", async () => {
    const ticketId = randomUUID();

    await publishCreated(ticketId);

    const row = await waitFor(() => readReplica(ticketId), 3_000);
    expect(row).toMatchObject({
      id: ticketId,
      title: "Original title",
      unitPriceCents: 4500,
      version: 1,
    });
  }, 30_000);

  it("re-replicates title and price from tickets.updated.v1", async () => {
    const ticketId = randomUUID();

    await publishCreated(ticketId);
    await waitFor(() => readReplica(ticketId), 3_000);

    await publishUpdated({ ticketId, title: "Rescheduled", unitPriceCents: 5200, version: 2 });

    const row = await waitFor(async () => {
      const r = await readReplica(ticketId);
      return r?.version === 2 ? r : undefined;
    }, 3_000);
    expect(row).toMatchObject({ title: "Rescheduled", unitPriceCents: 5200, version: 2 });
  }, 30_000);

  it("ignores a stale tickets.updated.v1 whose version is not ahead of the replica", async () => {
    const ticketId = randomUUID();

    await publishCreated(ticketId);
    await waitFor(() => readReplica(ticketId), 3_000);

    await publishUpdated({ ticketId, title: "Newer", unitPriceCents: 7000, version: 3 });
    await waitFor(async () => {
      const r = await readReplica(ticketId);
      return r?.version === 3 ? r : undefined;
    }, 3_000);

    // A late redelivery of an older edit (version 2) must not clobber version 3.
    await publishUpdated({ ticketId, title: "Stale", unitPriceCents: 1, version: 2 });
    await new Promise((r) => setTimeout(r, 500));

    const row = await readReplica(ticketId);
    expect(row).toMatchObject({ title: "Newer", unitPriceCents: 7000, version: 3 });
  }, 30_000);
});
