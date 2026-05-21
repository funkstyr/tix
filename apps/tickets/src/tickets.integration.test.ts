import { createRouterClient } from "@orpc/server";
import { createAuth } from "auth/instance";
import { createAuthRouter } from "auth/router";
import { authTables } from "auth/schema";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "@tix/db-core/client";

import { createInProcessAuthSessionClient } from "./auth-session-client.ts";
import { createTicketsRouter } from "./router.ts";
import { tickets as ticketsTable, ticketsTables } from "./tickets-schema.ts";

const TEST_SECRET = "test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod";
const TEST_BASE_URL = "http://localhost:4001";
const INVALID_TOKEN = "definitely-not-a-valid-session-token";

const authMigrations = fileURLToPath(new URL("../../auth/drizzle", import.meta.url));
const ticketsMigrations = fileURLToPath(new URL("../drizzle", import.meta.url));

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

type TicketsDbClient = DbClient<typeof ticketsTables>;
type AuthDbClient = DbClient<typeof authTables>;
type TicketsRouterClient = ReturnType<typeof buildClients>["ticketsClient"];
type AuthRouterClient = ReturnType<typeof buildClients>["authClient"];

function buildClients(ticketsDb: TicketsDbClient, authDb: AuthDbClient) {
  const auth = createAuth({ db: authDb.db, secret: TEST_SECRET, baseURL: TEST_BASE_URL });
  const authRouter = createAuthRouter({ auth });
  const authSessionClient = createInProcessAuthSessionClient(authRouter);
  const ticketsRouter = createTicketsRouter({ db: ticketsDb, authClient: authSessionClient });

  return {
    authClient: createRouterClient(authRouter),
    ticketsClient: createRouterClient(ticketsRouter),
  };
}

let container: StartedTestContainer | undefined;
let ticketsDb: TicketsDbClient | undefined;
let authDb: AuthDbClient | undefined;
let ticketsClient: TicketsRouterClient | undefined;
let authClient: AuthRouterClient | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "tickets_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgres://postgres:postgres@${host}:${port}/tickets_test`;

  authDb = createDbClient("auth", url, { schema: authTables });
  await migrate(authDb.db, { migrationsFolder: authMigrations });

  ticketsDb = createDbClient("tickets", url, { schema: ticketsTables });
  await migrate(ticketsDb.db, { migrationsFolder: ticketsMigrations });

  const clients = buildClients(ticketsDb, authDb);
  authClient = clients.authClient;
  ticketsClient = clients.ticketsClient;
}, 120_000);

afterAll(async () => {
  await ticketsDb?.close();
  await authDb?.close();
  await container?.stop();
});

beforeEach(async () => {
  if (!ticketsDb || !authDb) return;

  await ticketsDb.sql`TRUNCATE TABLE tickets.tickets RESTART IDENTITY CASCADE`;
  await authDb.sql`TRUNCATE TABLE auth.session, auth.account, auth.user RESTART IDENTITY CASCADE`;
});

function getAuthClient(): AuthRouterClient {
  if (!authClient) throw new Error("authClient not initialized");

  return authClient;
}

function getTicketsClient(): TicketsRouterClient {
  if (!ticketsClient) throw new Error("ticketsClient not initialized");

  return ticketsClient;
}

function getTicketsDb(): TicketsDbClient {
  if (!ticketsDb) throw new Error("ticketsDb not initialized");

  return ticketsDb;
}

async function signUpSeller(email: string): Promise<{ userId: string; token: string }> {
  const result = await getAuthClient().signUp({
    email,
    password: "correct-horse-battery",
    name: email.split("@")[0] ?? "seller",
  });

  return { userId: result.userId, token: result.token };
}

describe.skipIf(!dockerAvailable)("tickets router", () => {
  it("rejects tickets.create with an invalid session token", async () => {
    const create = getTicketsClient().create({
      token: INVALID_TOKEN,
      title: "Aphex Twin @ Warehouse",
      quantityTotal: 100,
      unitPriceCents: 4500,
    });

    await expect(create).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("persists a row with quantityAvailable = quantityTotal and version = 1 when signed in", async () => {
    const seller = await signUpSeller("alice@example.com");

    const created = await getTicketsClient().create({
      token: seller.token,
      title: "Aphex Twin @ Warehouse",
      quantityTotal: 100,
      unitPriceCents: 4500,
    });

    expect(created.sellerId).toBe(seller.userId);
    expect(created.title).toBe("Aphex Twin @ Warehouse");
    expect(created.quantityTotal).toBe(100);
    expect(created.quantityAvailable).toBe(100);
    expect(created.unitPriceCents).toBe(4500);
    expect(created.version).toBe(1);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, created.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantityAvailable).toBe(100);
    expect(rows[0]?.version).toBe(1);
  });

  it("rejects zero or negative quantityTotal before reaching the database", async () => {
    const seller = await signUpSeller("bob@example.com");

    const zero = getTicketsClient().create({
      token: seller.token,
      title: "Free seats",
      quantityTotal: 0,
      unitPriceCents: 4500,
    });
    const negative = getTicketsClient().create({
      token: seller.token,
      title: "Owe me money",
      quantityTotal: -3,
      unitPriceCents: 4500,
    });

    await expect(zero).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(negative).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const rows = await getTicketsDb().db.select().from(ticketsTable);
    expect(rows).toHaveLength(0);
  });

  it("tickets.getById returns the created row", async () => {
    const seller = await signUpSeller("carol@example.com");
    const created = await getTicketsClient().create({
      token: seller.token,
      title: "Boards of Canada @ Concorde",
      quantityTotal: 50,
      unitPriceCents: 7500,
    });

    const fetched = await getTicketsClient().getById({ ticketId: created.id });

    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.sellerId).toBe(seller.userId);
    expect(fetched?.quantityAvailable).toBe(50);
  });

  it("tickets.getById returns null for an unknown id", async () => {
    const missing = await getTicketsClient().getById({
      ticketId: "00000000-0000-4000-8000-000000000000",
    });
    expect(missing).toBeNull();
  });
});
