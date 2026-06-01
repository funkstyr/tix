import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { createRouterClient } from "@orpc/server";
import { ArkErrors } from "arktype";
import { createAuth } from "auth/instance";
import { createAuthRouter } from "auth/router";
import { authTables } from "auth/schema";
import { createAuthTestRuntime } from "auth/test-runtime";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Effect, Fiber } from "effect";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createTicketsRouter } from "tickets/router";
import { tickets as ticketsTable, ticketsTables } from "tickets/schema";
import { createTicketsTestRuntime } from "tickets/test-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthRouterClient } from "@tix/contracts/auth";
import { createInProcessAuthSessionClient } from "@tix/contracts/auth-client";
import { orderCreatedV1 } from "@tix/contracts/orders";
import { ORDER_CREATED_V1, ORDER_RESERVATION_RELEASED_V1 } from "@tix/contracts/subjects";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { outboxRelay } from "@tix/db-core/outbox";
import {
  consumer,
  createPublisher,
  defaultScopedRunner,
  runScopedConsumer,
  type RunningConsumer,
} from "@tix/messaging/jetstream";

import {
  orders as ordersTable,
  ordersOutbox as ordersOutboxTable,
  ordersTables,
} from "../domain/schema.ts";
import { createOrdersTestRuntime } from "../runtime/test-runtime.ts";
import { createInProcessTicketsClient, type TicketsClient } from "../tickets-client.ts";
import { createOrdersRouter } from "./router.ts";

function runRelay(
  db: Parameters<typeof outboxRelay>[0],
  table: Parameters<typeof outboxRelay>[1],
  publish: Parameters<typeof outboxRelay>[2],
  options: Parameters<typeof outboxRelay>[3],
): { stop: () => Promise<void> } {
  const fiber = Effect.runFork(outboxRelay(db, table, publish, options));
  return { stop: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined) };
}

const TEST_SECRET = "test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod";
const TEST_BASE_URL = "http://localhost:4001";
const TEST_SERVICE_TOKEN = "test-service-token";

const authMigrations = fileURLToPath(new URL("../../../auth/drizzle", import.meta.url));
const ticketsMigrations = fileURLToPath(new URL("../../../tickets/drizzle", import.meta.url));
const ordersMigrations = fileURLToPath(new URL("../../drizzle", import.meta.url));

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
type TicketsDbClient = DbClient<typeof ticketsTables>;
type AuthDbClient = DbClient<typeof authTables>;
type Harness = ReturnType<typeof buildClients>;

function buildClients(ordersDb: OrdersDbClient, ticketsDb: TicketsDbClient, authDb: AuthDbClient) {
  const auth = createAuth({ db: authDb.db, secret: TEST_SECRET, baseURL: TEST_BASE_URL });
  const authRouter = createAuthRouter(createAuthTestRuntime({ auth }));
  const authRouterClient: AuthRouterClient = createRouterClient(authRouter);
  const authSessionClient = createInProcessAuthSessionClient(authRouterClient);

  const ticketsRuntime = createTicketsTestRuntime({
    db: ticketsDb,
    authClient: authSessionClient,
    serviceToken: TEST_SERVICE_TOKEN,
  });
  const ticketsRouter = createTicketsRouter(ticketsRuntime);
  const ticketsRouterClient = createRouterClient(ticketsRouter, {
    context: { otelParent: ROOT_CONTEXT, serviceToken: TEST_SERVICE_TOKEN },
  });
  const ticketsClient = createInProcessTicketsClient(ticketsRouterClient);

  function buildOrdersClient(opts: { db?: OrdersDbClient; client?: TicketsClient } = {}) {
    const runtime = createOrdersTestRuntime({
      db: opts.db ?? ordersDb,
      authClient: authSessionClient,
      ticketsClient: opts.client ?? ticketsClient,
      reservationTtlMs: 15 * 60 * 1000,
    });
    const ordersRouter = createOrdersRouter(runtime);

    return createRouterClient(ordersRouter, { context: { otelParent: ROOT_CONTEXT } });
  }

  return {
    authClient: authRouterClient,
    ticketsClient: ticketsRouterClient,
    rawTicketsClient: ticketsClient,
    ordersClient: buildOrdersClient(),
    buildOrdersClient,
  };
}

let pgContainer: StartedTestContainer | undefined;
let natsContainer: StartedTestContainer | undefined;
let nats: NatsConnection | undefined;
let ordersDb: OrdersDbClient | undefined;
let ticketsDb: TicketsDbClient | undefined;
let authDb: AuthDbClient | undefined;
let harness: Harness | undefined;
let relay: { stop: () => Promise<void> } | undefined;
let streamName: string | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "orders_e2e",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/orders_e2e`;

  authDb = createDbClient("auth", pgUrl, { schema: authTables });
  await migrate(authDb.db, { migrationsFolder: authMigrations });

  ticketsDb = createDbClient("tickets", pgUrl, { schema: ticketsTables });
  await migrate(ticketsDb.db, { migrationsFolder: ticketsMigrations });

  ordersDb = createDbClient("orders", pgUrl, { schema: ordersTables });
  await migrate(ordersDb.db, { migrationsFolder: ordersMigrations });

  harness = buildClients(ordersDb, ticketsDb, authDb);

  const natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;
  nats = await connect({ servers: natsUrl });

  streamName = `S_${randomUUID().replace(/-/g, "")}`;
  const manager = await jetstreamManager(nats);
  await manager.streams.add({
    name: streamName,
    subjects: [ORDER_CREATED_V1, ORDER_RESERVATION_RELEASED_V1],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
  });

  const publisher = createPublisher(nats);
  relay = runRelay(ordersDb.db, ordersOutboxTable, publisher.publish, {
    pollIntervalMs: 50,
  });
}, 180_000);

afterAll(async () => {
  await relay?.stop();
  await nats?.close();
  await ordersDb?.close();
  await ticketsDb?.close();
  await authDb?.close();
  await natsContainer?.stop();
  await pgContainer?.stop();
});

beforeEach(async () => {
  if (!ordersDb || !ticketsDb || !authDb) return;
  await ordersDb.sql`TRUNCATE TABLE orders.orders, orders.outbox RESTART IDENTITY CASCADE`;
  await ticketsDb.sql`TRUNCATE TABLE tickets.tickets, tickets.outbox RESTART IDENTITY CASCADE`;
  await authDb.sql`TRUNCATE TABLE auth.session, auth.account, auth.user RESTART IDENTITY CASCADE`;
});

function requireHarness(): {
  harness: Harness;
  nats: NatsConnection;
  stream: string;
  ordersDb: OrdersDbClient;
  ticketsDb: TicketsDbClient;
} {
  if (!harness || !nats || !streamName || !ordersDb || !ticketsDb) {
    throw new Error("test harness not initialized");
  }

  return { harness, nats, stream: streamName, ordersDb, ticketsDb };
}

async function signUp(
  auth: AuthRouterClient,
  email: string,
): Promise<{ userId: string; token: string }> {
  const result = await auth.signUp({
    email,
    password: "correct-horse-battery",
    name: email.split("@")[0] ?? "user",
  });

  return { userId: result.userId, token: result.token };
}

describe.skipIf(!dockerAvailable)("orders.create → order.created.v1 on NATS", () => {
  it("delivers a schema-valid order.created.v1 to a subscriber within 2s", async () => {
    const { harness: h, nats: nc, stream } = requireHarness();

    const seller = await signUp(h.authClient, `seller-${randomUUID()}@example.com`);
    const buyer = await signUp(h.authClient, `buyer-${randomUUID()}@example.com`);
    const ticket = await h.ticketsClient.create({
      token: seller.token,
      title: `Concert ${randomUUID().slice(0, 6)}`,
      quantityTotal: 5,
      unitPriceCents: 5000,
    });

    let resolveEvent!: (args: { eventId: string; payload: unknown }) => void;
    const received = new Promise<{ eventId: string; payload: unknown }>((r) => {
      resolveEvent = r;
    });

    const group = `g-${randomUUID().replace(/-/g, "")}`;
    const consumerHandle: RunningConsumer = await runScopedConsumer(
      defaultScopedRunner,
      consumer(nc, {
        stream,
        subjectFilter: ORDER_CREATED_V1,
        group,
        schema: orderCreatedV1,
        handler: ({ eventId, payload }) =>
          Effect.sync(() => {
            resolveEvent({ eventId, payload });
          }),
      }),
    );

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const order = await h.ordersClient.create({
        token: buyer.token,
        ticketId: ticket.id,
        quantity: 2,
      });

      const observed = await Promise.race([
        received,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("did not receive order.created.v1 within 2s")),
            2_000,
          );
        }),
      ]);

      const validated = orderCreatedV1(observed.payload);
      expect(validated instanceof ArkErrors).toBe(false);

      expect(observed.payload).toMatchObject({
        orderId: order.id,
        ticketId: ticket.id,
        buyerId: buyer.userId,
        quantity: 2,
        priceCents: 10_000,
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      await consumerHandle.stop();
    }
  }, 30_000);

  it("emits no Order row, no outbox row, and no event when tickets.reserve returns 409", async () => {
    const {
      harness: h,
      nats: nc,
      stream,
      ordersDb: ordersDbRef,
      ticketsDb: ticketsDbRef,
    } = requireHarness();

    const seller = await signUp(h.authClient, `seller-${randomUUID()}@example.com`);
    const buyer = await signUp(h.authClient, `buyer-${randomUUID()}@example.com`);
    const ticket = await h.ticketsClient.create({
      token: seller.token,
      title: `Sold ${randomUUID().slice(0, 6)}`,
      quantityTotal: 1,
      unitPriceCents: 5000,
    });

    // Drain the single seat directly so the buyer's reserve will see a 409.
    // We use a quantity larger than what remains to force CONFLICT (the create
    // handler pre-checks getById, but a >=1 reserve against 0 inventory yields
    // CONFLICT inside tickets.reserve, which the orders create handler maps to
    // a 409 race_lost.
    await h.ticketsClient.reserve({ ticketId: ticket.id, quantity: 1 });

    // Consumer replays from the start of the stream (DeliverPolicy.All), so we
    // filter by THIS buyer's userId — events from earlier tests in this process
    // share the stream but use different user IDs.
    let observedEvent = false;
    const group = `g-${randomUUID().replace(/-/g, "")}`;
    const consumerHandle: RunningConsumer = await runScopedConsumer(
      defaultScopedRunner,
      consumer(nc, {
        stream,
        subjectFilter: ORDER_CREATED_V1,
        group,
        schema: orderCreatedV1,
        handler: ({ payload }) =>
          Effect.sync(() => {
            if (payload.buyerId === buyer.userId) observedEvent = true;
          }),
      }),
    );

    try {
      // Force the orders router to call tickets.reserve (skip the early
      // sold_out guard) by wrapping ticketsClient.getById to report stale stock.
      const lyingClient: TicketsClient = {
        getById: async (input) => {
          const fresh = await h.rawTicketsClient.getById(input);
          if (!fresh) return null;

          return { ...fresh, quantityAvailable: 5 };
        },
        reserve: (input) => h.rawTicketsClient.reserve(input),
      };
      const racingOrders = h.buildOrdersClient({ client: lyingClient });

      await expect(
        racingOrders.create({ token: buyer.token, ticketId: ticket.id, quantity: 1 }),
      ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });

      // Wait long enough for the 50ms relay tick to have fired several times.
      await new Promise((r) => setTimeout(r, 500));

      const orderRows = await ordersDbRef.db.select().from(ordersTable);
      expect(orderRows).toHaveLength(0);

      const outboxRows = await ordersDbRef.db.select().from(ordersOutboxTable);
      expect(outboxRows).toHaveLength(0);

      expect(observedEvent).toBe(false);

      const [ticketRow] = await ticketsDbRef.db
        .select()
        .from(ticketsTable)
        .where(eq(ticketsTable.id, ticket.id));
      expect(ticketRow?.quantityAvailable).toBe(0);
    } finally {
      await consumerHandle.stop();
    }
  }, 30_000);

  it("flags a known correctness gap: a crash between tickets.reserve and order insert leaves inventory decremented without an Order", async () => {
    // TODO(#16): apps/tickets does not yet consume order.reservation_released.v1,
    // so when this gap fires the inventory stays drifted. The compensating event
    // PRD covers closing this loop end-to-end; until it lands, an operator must
    // reconcile manually if the orders process crashes between a successful
    // tickets.reserve and the order insert transaction.
    const { harness: h, ordersDb: ordersDbRef, ticketsDb: ticketsDbRef } = requireHarness();

    const seller = await signUp(h.authClient, `seller-${randomUUID()}@example.com`);
    const buyer = await signUp(h.authClient, `buyer-${randomUUID()}@example.com`);
    const ticket = await h.ticketsClient.create({
      token: seller.token,
      title: `Crash ${randomUUID().slice(0, 6)}`,
      quantityTotal: 3,
      unitPriceCents: 5000,
    });

    // Fail-injection: wrap the orders db so the transaction throws AFTER
    // tickets.reserve has already decremented inventory. Bind non-transaction
    // methods back to the real db so drizzle's internal `this` access still
    // resolves to the original instance (the Proxy doesn't carry private fields).
    const failingDb: OrdersDbClient = {
      ...ordersDbRef,
      db: new Proxy(ordersDbRef.db, {
        get(target, prop) {
          if (prop === "transaction") {
            return () => Promise.reject(new Error("injected crash between reserve and insert"));
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as OrdersDbClient["db"],
    };
    const crashingOrders = h.buildOrdersClient({ db: failingDb });

    await expect(
      crashingOrders.create({ token: buyer.token, ticketId: ticket.id, quantity: 2 }),
    ).rejects.toBeDefined();

    const orderRows = await ordersDbRef.db.select().from(ordersTable);
    expect(orderRows).toHaveLength(0);

    const [ticketRow] = await ticketsDbRef.db
      .select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, ticket.id));
    expect(ticketRow?.quantityAvailable).toBe(1);
  }, 30_000);
});
