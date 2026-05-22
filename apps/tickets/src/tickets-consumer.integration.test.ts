import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ORDER_RESERVATION_RELEASED_V1 } from "@tix/contracts/subjects";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher, type RunningConsumer } from "@tix/messaging/jetstream";
import { dockerAvailable } from "@tix/test-helpers/docker-available";
import { requireValue } from "@tix/test-helpers/require-value";
import { waitFor } from "@tix/test-helpers/wait-for";

import { startTicketsReleasedConsumer } from "./tickets-consumer.ts";
import {
  tickets as ticketsTable,
  ticketsInbox as ticketsInboxTable,
  ticketsTables,
} from "./tickets-schema.ts";

const ticketsMigrations = fileURLToPath(new URL("../drizzle", import.meta.url));

type TicketsDbClient = DbClient<typeof ticketsTables>;

let pgContainer: StartedTestContainer | undefined;
let natsContainer: StartedTestContainer | undefined;
let nats: NatsConnection | undefined;
let ticketsDb: TicketsDbClient | undefined;
let streamName: string | undefined;
let consumer: RunningConsumer | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "tickets_released_e2e",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/tickets_released_e2e`;
  ticketsDb = createDbClient("tickets", pgUrl, { schema: ticketsTables });
  await migrate(ticketsDb.db, { migrationsFolder: ticketsMigrations });

  const natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;
  nats = await connect({ servers: natsUrl });
}, 180_000);

afterAll(async () => {
  await nats?.close();
  await ticketsDb?.close();
  await natsContainer?.stop();
  await pgContainer?.stop();
});

beforeEach(async () => {
  if (!dockerAvailable) return;
  const dbRef = requireValue(ticketsDb, "ticketsDb");
  const nc = requireValue(nats, "nats");

  await dbRef.sql`TRUNCATE TABLE tickets.tickets, tickets.outbox, tickets.inbox RESTART IDENTITY CASCADE`;

  streamName = `S_${randomUUID().replace(/-/g, "")}`;
  const manager = await jetstreamManager(nc);
  await manager.streams.add({
    name: streamName,
    subjects: [ORDER_RESERVATION_RELEASED_V1],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
    // Disable publish-side dedupe so the second publish actually reaches the
    // consumer — that's what exercises the inbox-dedupe code path in handler.
    duplicate_window: 0,
  });

  consumer = await startTicketsReleasedConsumer({
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

type SeedTicketArgs = { quantityTotal?: number; quantityAvailable?: number };

async function seedTicket(args: SeedTicketArgs = {}): Promise<{
  id: string;
  quantityTotal: number;
  quantityAvailable: number;
}> {
  const dbRef = requireValue(ticketsDb, "ticketsDb");
  const id = randomUUID();
  const quantityTotal = args.quantityTotal ?? 4;
  const quantityAvailable = args.quantityAvailable ?? 2;

  await dbRef.db.insert(ticketsTable).values({
    id,
    sellerId: `seller-${randomUUID()}`,
    title: "Boards of Canada @ Concorde",
    quantityTotal,
    quantityAvailable,
    unitPriceCents: 7500,
  });

  return { id, quantityTotal, quantityAvailable };
}

async function publishReleased(args: {
  orderId: string;
  ticketId: string;
  quantity: number;
  eventId: string;
}): Promise<void> {
  const publisher = createPublisher(requireValue(nats, "nats"));
  await publisher.publish(
    ORDER_RESERVATION_RELEASED_V1,
    {
      orderId: args.orderId,
      ticketId: args.ticketId,
      quantity: args.quantity,
      releasedAt: new Date().toISOString(),
    },
    { msgId: args.eventId },
  );
}

async function readTicket(
  ticketId: string,
): Promise<{ quantityAvailable: number; version: number } | undefined> {
  const [row] = await requireValue(ticketsDb, "ticketsDb")
    .db.select()
    .from(ticketsTable)
    .where(eq(ticketsTable.id, ticketId));
  if (!row) return undefined;
  return { quantityAvailable: row.quantityAvailable, version: row.version };
}

describe.skipIf(!dockerAvailable)("tickets consumer for order.reservation_released.v1", () => {
  it("restores quantityAvailable and bumps version", async () => {
    const seeded = await seedTicket({ quantityTotal: 4, quantityAvailable: 2 });

    await publishReleased({
      orderId: randomUUID(),
      ticketId: seeded.id,
      quantity: 2,
      eventId: randomUUID(),
    });

    const after = await waitFor(async () => {
      const row = await readTicket(seeded.id);
      return row?.quantityAvailable === 4 ? row : undefined;
    }, 3_000);

    expect(after.quantityAvailable).toBe(4);
    expect(after.version).toBe(2);
  }, 30_000);

  it("dedupes redelivery: same eventId twice → quantity stays at 4 (not 6)", async () => {
    const seeded = await seedTicket({ quantityTotal: 4, quantityAvailable: 2 });
    const eventId = randomUUID();
    const orderId = randomUUID();

    await publishReleased({ orderId, ticketId: seeded.id, quantity: 2, eventId });
    await waitFor(async () => {
      const row = await readTicket(seeded.id);
      return row?.quantityAvailable === 4 ? row : undefined;
    }, 3_000);

    await publishReleased({ orderId, ticketId: seeded.id, quantity: 2, eventId });
    // Let the consumer have a chance to (mis)process the redelivery.
    await new Promise((r) => setTimeout(r, 500));

    const dbRef = requireValue(ticketsDb, "ticketsDb");
    const inboxRows = await dbRef.db
      .select()
      .from(ticketsInboxTable)
      .where(eq(ticketsInboxTable.eventId, eventId));
    expect(inboxRows).toHaveLength(1);

    const row = await readTicket(seeded.id);
    expect(row?.quantityAvailable).toBe(4);
    expect(row?.version).toBe(2);
  }, 30_000);

  it("concurrent releases for the same Ticket (different orderIds) both reflected exactly once", async () => {
    const seeded = await seedTicket({ quantityTotal: 8, quantityAvailable: 0 });

    await Promise.all([
      publishReleased({
        orderId: randomUUID(),
        ticketId: seeded.id,
        quantity: 3,
        eventId: randomUUID(),
      }),
      publishReleased({
        orderId: randomUUID(),
        ticketId: seeded.id,
        quantity: 5,
        eventId: randomUUID(),
      }),
    ]);

    const after = await waitFor(async () => {
      const row = await readTicket(seeded.id);
      return row?.quantityAvailable === 8 ? row : undefined;
    }, 5_000);

    expect(after.quantityAvailable).toBe(8);
    // Two successful versioned updates → version bumped twice.
    expect(after.version).toBe(3);

    const dbRef = requireValue(ticketsDb, "ticketsDb");
    const inboxRows = await dbRef.db.select().from(ticketsInboxTable);
    expect(inboxRows).toHaveLength(2);
  }, 30_000);
});
