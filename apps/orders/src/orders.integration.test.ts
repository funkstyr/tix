import { createRouterClient } from "@orpc/server";
import { createAuth } from "auth/instance";
import { createAuthRouter } from "auth/router";
import { authTables } from "auth/schema";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createTicketsRouter } from "tickets/router";
import { tickets as ticketsTable, ticketsTables } from "tickets/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthRouterClient } from "@tix/contracts/auth";
import { createDbClient, type DbClient } from "@tix/db-core/client";

import { createInProcessAuthSessionClient } from "./auth-session-client.ts";
import { orders as ordersTable, ordersTables } from "./orders-schema.ts";
import { createOrdersRouter } from "./router.ts";
import { createInProcessTicketsClient, type TicketsClient } from "./tickets-client.ts";

const TEST_SECRET = "test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod";
const TEST_BASE_URL = "http://localhost:4001";
const TEST_SERVICE_TOKEN = "test-service-token";
const INVALID_TOKEN = "definitely-not-a-valid-session-token";

const authMigrations = fileURLToPath(new URL("../../auth/drizzle", import.meta.url));
const ticketsMigrations = fileURLToPath(new URL("../../tickets/drizzle", import.meta.url));
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
type TicketsDbClient = DbClient<typeof ticketsTables>;
type AuthDbClient = DbClient<typeof authTables>;
type OrdersRouterClient = ReturnType<typeof buildClients>["ordersClient"];
type Harness = ReturnType<typeof buildClients>;

function buildClients(ordersDb: OrdersDbClient, ticketsDb: TicketsDbClient, authDb: AuthDbClient) {
  const auth = createAuth({ db: authDb.db, secret: TEST_SECRET, baseURL: TEST_BASE_URL });
  const authRouter = createAuthRouter({ auth });
  const authRouterClient: AuthRouterClient = createRouterClient(authRouter);
  const authSessionClient = createInProcessAuthSessionClient(authRouterClient);

  const ticketsRouter = createTicketsRouter({
    db: ticketsDb,
    authClient: authSessionClient,
    serviceToken: TEST_SERVICE_TOKEN,
  });
  const ticketsRouterClient = createRouterClient(ticketsRouter, {
    context: { serviceToken: TEST_SERVICE_TOKEN },
  });
  const ticketsClient = createInProcessTicketsClient(ticketsRouterClient);

  function buildOrdersClient(client: TicketsClient = ticketsClient) {
    const ordersRouter = createOrdersRouter({
      db: ordersDb,
      authClient: authSessionClient,
      ticketsClient: client,
    });

    return createRouterClient(ordersRouter);
  }

  return {
    authClient: authRouterClient,
    ticketsClient: ticketsRouterClient,
    rawTicketsClient: ticketsClient,
    ordersClient: buildOrdersClient(),
    buildOrdersClient,
  };
}

let container: StartedTestContainer | undefined;
let ordersDb: OrdersDbClient | undefined;
let ticketsDb: TicketsDbClient | undefined;
let authDb: AuthDbClient | undefined;
let harness: Harness | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "orders_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgres://postgres:postgres@${host}:${port}/orders_test`;

  authDb = createDbClient("auth", url, { schema: authTables });
  await migrate(authDb.db, { migrationsFolder: authMigrations });

  ticketsDb = createDbClient("tickets", url, { schema: ticketsTables });
  await migrate(ticketsDb.db, { migrationsFolder: ticketsMigrations });

  ordersDb = createDbClient("orders", url, { schema: ordersTables });
  await migrate(ordersDb.db, { migrationsFolder: ordersMigrations });

  harness = buildClients(ordersDb, ticketsDb, authDb);
}, 120_000);

afterAll(async () => {
  await ordersDb?.close();
  await ticketsDb?.close();
  await authDb?.close();
  await container?.stop();
});

beforeEach(async () => {
  if (!ordersDb || !ticketsDb || !authDb) return;

  await ordersDb.sql`TRUNCATE TABLE orders.orders RESTART IDENTITY CASCADE`;
  await ticketsDb.sql`TRUNCATE TABLE tickets.tickets, tickets.outbox RESTART IDENTITY CASCADE`;
  await authDb.sql`TRUNCATE TABLE auth.session, auth.account, auth.user RESTART IDENTITY CASCADE`;
});

function getHarness(): Harness {
  if (!harness) throw new Error("harness not initialized");

  return harness;
}

function getAuthClient(): AuthRouterClient {
  return getHarness().authClient;
}

function getOrdersClient(): OrdersRouterClient {
  return getHarness().ordersClient;
}

function getOrdersDb(): OrdersDbClient {
  if (!ordersDb) throw new Error("ordersDb not initialized");

  return ordersDb;
}

function getTicketsDb(): TicketsDbClient {
  if (!ticketsDb) throw new Error("ticketsDb not initialized");

  return ticketsDb;
}

function getTicketsAdminClient() {
  return getHarness().ticketsClient;
}

function withReserveBarrier(client: TicketsClient, gates: number): TicketsClient {
  let pending = gates;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    getById: async (input) => {
      const result = await client.getById(input);
      pending -= 1;
      if (pending === 0) release();

      return result;
    },
    reserve: async (input) => {
      await barrier;

      return client.reserve(input);
    },
  };
}

async function signUpUser(email: string): Promise<{ userId: string; token: string }> {
  const result = await getAuthClient().signUp({
    email,
    password: "correct-horse-battery",
    name: email.split("@")[0] ?? "user",
  });

  return { userId: result.userId, token: result.token };
}

async function createTicket(sellerToken: string, quantityTotal: number): Promise<{ id: string }> {
  const created = await getTicketsAdminClient().create({
    token: sellerToken,
    title: `Concert ${randomTag()}`,
    quantityTotal,
    unitPriceCents: 5000,
  });

  return { id: created.id };
}

function randomTag(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe.skipIf(!dockerAvailable)("orders.create", () => {
  it("creates an Order, decrements the Ticket, sets expiresAt 15min ahead", async () => {
    const seller = await signUpUser("seller@example.com");
    const buyer = await signUpUser("buyer@example.com");
    const ticket = await createTicket(seller.token, 5);

    const before = Date.now();
    const order = await getOrdersClient().create({
      token: buyer.token,
      ticketId: ticket.id,
      quantity: 2,
    });
    const after = Date.now();

    expect(order.buyerId).toBe(buyer.userId);
    expect(order.ticketId).toBe(ticket.id);
    expect(order.quantity).toBe(2);
    expect(order.status).toBe("created");
    expect(order.version).toBe(1);

    const expiresAtMs = Date.parse(order.expiresAt);
    const fifteenMin = 15 * 60 * 1000;
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + fifteenMin);
    expect(expiresAtMs).toBeLessThanOrEqual(after + fifteenMin);

    const [row] = await getOrdersDb()
      .db.select()
      .from(ordersTable)
      .where(eq(ordersTable.id, order.id));
    expect(row?.status).toBe("created");
    expect(row?.quantity).toBe(2);

    const [ticketRow] = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, ticket.id));
    expect(ticketRow?.quantityAvailable).toBe(3);
  });

  it("rejects an unauthenticated buyer with 401 and writes no Order row", async () => {
    const seller = await signUpUser("seller-unauth@example.com");
    const ticket = await createTicket(seller.token, 3);

    const call = getOrdersClient().create({
      token: INVALID_TOKEN,
      ticketId: ticket.id,
      quantity: 1,
    });

    await expect(call).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const rows = await getOrdersDb().db.select().from(ordersTable);
    expect(rows).toHaveLength(0);

    const [ticketRow] = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, ticket.id));
    expect(ticketRow?.quantityAvailable).toBe(3);
  });

  it("rejects a sold-out Ticket with 410 and writes no Order row", async () => {
    const seller = await signUpUser("seller-soldout@example.com");
    const buyer = await signUpUser("buyer-soldout@example.com");
    const ticket = await createTicket(seller.token, 1);

    // Drain inventory directly via the tickets reserve client to put the
    // ticket in a stable sold-out state.
    await getTicketsAdminClient().reserve({ ticketId: ticket.id, quantity: 1 });

    const call = getOrdersClient().create({
      token: buyer.token,
      ticketId: ticket.id,
      quantity: 1,
    });

    await expect(call).rejects.toMatchObject({
      code: "GONE",
      status: 410,
      data: { reason: "sold_out" },
    });

    const rows = await getOrdersDb().db.select().from(ordersTable);
    expect(rows).toHaveLength(0);
  });

  it("lets exactly one of two concurrent buyers claim the last unit", async () => {
    const seller = await signUpUser("seller-race@example.com");
    const buyerA = await signUpUser("buyer-a@example.com");
    const buyerB = await signUpUser("buyer-b@example.com");
    const ticket = await createTicket(seller.token, 1);

    // Hold reserve until both getById's resolve, so both buyers enter the
    // reserve race with the same pre-reserve view of inventory. Without this,
    // one buyer's full create can finish before the other's getById, which
    // surfaces as a stable sold-out (410) rather than a race conflict (409).
    const barrierClient = withReserveBarrier(getHarness().rawTicketsClient, 2);
    const raceClient = getHarness().buildOrdersClient(barrierClient);

    const results = await Promise.allSettled([
      raceClient.create({ token: buyerA.token, ticketId: ticket.id, quantity: 1 }),
      raceClient.create({ token: buyerB.token, ticketId: ticket.id, quantity: 1 }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const loser = rejected[0];
    if (loser?.status !== "rejected") throw new Error("expected one rejection");
    expect(loser.reason).toMatchObject({ code: "CONFLICT", status: 409 });

    const rows = await getOrdersDb().db.select().from(ordersTable);
    expect(rows).toHaveLength(1);

    const [ticketRow] = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, ticket.id));
    expect(ticketRow?.quantityAvailable).toBe(0);
  });

  it("rejects a buyer that is the same User as the Ticket's seller with 403", async () => {
    const owner = await signUpUser("owner@example.com");
    const ticket = await createTicket(owner.token, 3);

    const call = getOrdersClient().create({
      token: owner.token,
      ticketId: ticket.id,
      quantity: 1,
    });

    await expect(call).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    const rows = await getOrdersDb().db.select().from(ordersTable);
    expect(rows).toHaveLength(0);

    const [ticketRow] = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, ticket.id));
    expect(ticketRow?.quantityAvailable).toBe(3);
  });

  it("orders.getById returns the created Order", async () => {
    const seller = await signUpUser("seller-getby@example.com");
    const buyer = await signUpUser("buyer-getby@example.com");
    const ticket = await createTicket(seller.token, 4);

    const created = await getOrdersClient().create({
      token: buyer.token,
      ticketId: ticket.id,
      quantity: 1,
    });

    const fetched = await getOrdersClient().getById({ orderId: created.id });

    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.buyerId).toBe(buyer.userId);
    expect(fetched?.quantity).toBe(1);
    expect(fetched?.status).toBe("created");
  });

  it("orders.getById returns null for an unknown id", async () => {
    const missing = await getOrdersClient().getById({
      orderId: "00000000-0000-4000-8000-000000000000",
    });
    expect(missing).toBeNull();
  });
});
