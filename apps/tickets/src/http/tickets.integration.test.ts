import { ROOT_CONTEXT } from "@opentelemetry/api";
import { createRouterClient } from "@orpc/server";
import { createAuth } from "auth/instance";
import { createAuthRouter } from "auth/router";
import { authTables } from "auth/schema";
import { createAuthTestRuntime } from "auth/test-runtime";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthRouterClient } from "@tix/contracts/auth";
import { createInProcessAuthSessionClient } from "@tix/contracts/auth-client";
import { createDbClient, type DbClient } from "@tix/db-core/client";

import { tickets as ticketsTable, ticketsTables } from "../domain/schema.ts";
import { createTicketsTestRuntime } from "../runtime/test-runtime.ts";
import { createTicketsRouter } from "./router.ts";

const TEST_SECRET = "test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod";
const TEST_BASE_URL = "http://localhost:4001";
const TEST_SERVICE_TOKEN = "test-service-token";
const INVALID_TOKEN = "definitely-not-a-valid-session-token";

const authMigrations = fileURLToPath(new URL("../../../auth/drizzle", import.meta.url));
const ticketsMigrations = fileURLToPath(new URL("../../drizzle", import.meta.url));

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
type TicketsRouter = ReturnType<typeof createTicketsRouter>;
type TicketsRouterClient = ReturnType<typeof buildClients>["ticketsClient"];

function buildClients(ticketsDb: TicketsDbClient, authDb: AuthDbClient) {
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

  return {
    authClient: authRouterClient,
    ticketsRouter,
    ticketsClient: createRouterClient(ticketsRouter, {
      context: { otelParent: ROOT_CONTEXT, serviceToken: TEST_SERVICE_TOKEN },
    }),
  };
}

let container: StartedTestContainer | undefined;
let ticketsDb: TicketsDbClient | undefined;
let authDb: AuthDbClient | undefined;
let ticketsClient: TicketsRouterClient | undefined;
let ticketsRouter: TicketsRouter | undefined;
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
  ticketsRouter = clients.ticketsRouter;
  ticketsClient = clients.ticketsClient;
}, 120_000);

afterAll(async () => {
  await ticketsDb?.close();
  await authDb?.close();
  await container?.stop();
});

beforeEach(async () => {
  if (!ticketsDb || !authDb) return;

  await ticketsDb.sql`TRUNCATE TABLE tickets.tickets, tickets.outbox RESTART IDENTITY CASCADE`;
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

function getTicketsRouter(): TicketsRouter {
  if (!ticketsRouter) throw new Error("ticketsRouter not initialized");

  return ticketsRouter;
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

    const rows = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, created.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantityAvailable).toBe(100);
    expect(rows[0]?.version).toBe(1);
  });

  it("writes a tickets.created.v1 outbox row in the same transaction as the ticket", async () => {
    const seller = await signUpSeller("dave@example.com");

    const created = await getTicketsClient().create({
      token: seller.token,
      title: "Squarepusher @ Fabric",
      quantityTotal: 25,
      unitPriceCents: 6000,
    });

    const outbox = await getTicketsDb()
      .sql`SELECT subject, payload, sent_at FROM tickets.outbox`.values();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.[0]).toBe("tickets.created.v1");

    const payload = outbox[0]?.[1] as Record<string, unknown>;
    expect(payload["ticketId"]).toBe(created.id);
    expect(payload["sellerId"]).toBe(seller.userId);
    expect(payload["title"]).toBe("Squarepusher @ Fabric");
    expect(payload["quantityTotal"]).toBe(25);
    expect(payload["unitPriceCents"]).toBe(6000);
    expect(typeof payload["createdAt"]).toBe("string");

    expect(outbox[0]?.[2]).toBeNull();
  });

  it("rejects invalid input at the arktype boundary", async () => {
    const seller = await signUpSeller("bob@example.com");

    const zero = getTicketsClient().create({
      token: seller.token,
      title: "Free seats",
      quantityTotal: 0,
      unitPriceCents: 4500,
    });

    await expect(zero).rejects.toMatchObject({ code: "BAD_REQUEST" });

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

  it("tickets.list returns rows newest first and honors the limit", async () => {
    const seller = await signUpSeller("lister@example.com");

    const first = await getTicketsClient().create({
      token: seller.token,
      title: "First",
      quantityTotal: 5,
      unitPriceCents: 1000,
    });
    const second = await getTicketsClient().create({
      token: seller.token,
      title: "Second",
      quantityTotal: 5,
      unitPriceCents: 2000,
    });
    const third = await getTicketsClient().create({
      token: seller.token,
      title: "Third",
      quantityTotal: 5,
      unitPriceCents: 3000,
    });

    const all = await getTicketsClient().list({});
    expect(all.items.map((t) => t.id)).toEqual([third.id, second.id, first.id]);
    expect(all.items[0]?.title).toBe("Third");

    const limited = await getTicketsClient().list({ limit: 2 });
    expect(limited.items).toHaveLength(2);
    expect(limited.items.map((t) => t.id)).toEqual([third.id, second.id]);
  });

  it("tickets.list returns an empty list when no rows exist", async () => {
    const result = await getTicketsClient().list({});
    expect(result.items).toEqual([]);
  });

  it("rejects tickets.listMine with an invalid session token", async () => {
    const call = getTicketsClient().listMine({ token: INVALID_TOKEN });

    await expect(call).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("tickets.listMine returns only the caller's rows newest-first and honors the limit", async () => {
    const seller = await signUpSeller("mine-seller@example.com");
    const other = await signUpSeller("other-seller@example.com");

    // Two of the caller's, with another seller's row sandwiched between to
    // prove the filter — not just the ordering — is what isolates rows.
    const first = await getTicketsClient().create({
      token: seller.token,
      title: "Mine 1",
      quantityTotal: 5,
      unitPriceCents: 1000,
    });
    await getTicketsClient().create({
      token: other.token,
      title: "Other seller",
      quantityTotal: 5,
      unitPriceCents: 1500,
    });
    const second = await getTicketsClient().create({
      token: seller.token,
      title: "Mine 2",
      quantityTotal: 5,
      unitPriceCents: 2000,
    });

    const mine = await getTicketsClient().listMine({ token: seller.token });
    expect(mine.items.map((t) => t.id)).toEqual([second.id, first.id]);
    expect(mine.items.every((t) => t.sellerId === seller.userId)).toBe(true);

    const limited = await getTicketsClient().listMine({ token: seller.token, limit: 1 });
    expect(limited.items).toHaveLength(1);
    expect(limited.items[0]?.id).toBe(second.id);
  });

  it("tickets.listMine returns an empty list when the caller has none", async () => {
    const seller = await signUpSeller("empty-seller@example.com");

    const result = await getTicketsClient().listMine({ token: seller.token });
    expect(result.items).toEqual([]);
  });
});

describe.skipIf(!dockerAvailable)("tickets.reserve", () => {
  async function createTicket(quantityTotal: number): Promise<{ id: string }> {
    const seller = await signUpSeller(`seller-${randomTag()}@example.com`);
    const created = await getTicketsClient().create({
      token: seller.token,
      title: `Reserve test ${randomTag()}`,
      quantityTotal,
      unitPriceCents: 5000,
    });

    return { id: created.id };
  }

  it("decrements quantityAvailable and bumps version on a successful reserve", async () => {
    const ticket = await createTicket(4);

    const result = await getTicketsClient().reserve({ ticketId: ticket.id, quantity: 2 });

    expect(result.ticketId).toBe(ticket.id);
    expect(result.quantityAvailable).toBe(2);
    expect(result.unitPriceCents).toBe(5000);
    expect(result.version).toBe(2);

    const [row] = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, ticket.id));
    expect(row?.quantityAvailable).toBe(2);
    expect(row?.version).toBe(2);
  });

  it("returns CONFLICT sold_out when quantityAvailable is less than requested", async () => {
    const ticket = await createTicket(1);

    const oversell = getTicketsClient().reserve({ ticketId: ticket.id, quantity: 5 });

    await expect(oversell).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      data: { reason: "sold_out" },
    });

    const [row] = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, ticket.id));
    expect(row?.quantityAvailable).toBe(1);
    expect(row?.version).toBe(1);
  });

  it("lets exactly one of two concurrent callers claim the last seats", async () => {
    const ticket = await createTicket(2);

    const results = await Promise.allSettled([
      getTicketsClient().reserve({ ticketId: ticket.id, quantity: 2 }),
      getTicketsClient().reserve({ ticketId: ticket.id, quantity: 2 }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winnerStatus = rejected[0];
    if (winnerStatus?.status !== "rejected") throw new Error("expected one rejection");
    // The loser's re-read sees quantityAvailable = 0, so this surfaces as sold_out.
    // A version_conflict only occurs when a third writer contends with the retry,
    // which two callers can't trigger.
    expect(winnerStatus.reason).toMatchObject({
      code: "CONFLICT",
      data: { reason: "sold_out" },
    });

    const [row] = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, ticket.id));
    expect(row?.quantityAvailable).toBe(0);
    expect(row?.version).toBe(2);
  });

  it("rejects callers that omit the service token with 401", async () => {
    const ticket = await createTicket(3);

    const noTokenClient = createRouterClient(getTicketsRouter(), {
      context: { otelParent: ROOT_CONTEXT },
    });
    const call = noTokenClient.reserve({ ticketId: ticket.id, quantity: 1 });

    await expect(call).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const [row] = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, ticket.id));
    expect(row?.quantityAvailable).toBe(3);
    expect(row?.version).toBe(1);
  });
});

describe.skipIf(!dockerAvailable)("tickets.update", () => {
  it("edits title and price, bumps version, and writes a tickets.updated.v1 outbox row", async () => {
    const seller = await signUpSeller(`edit-${randomTag()}@example.com`);
    const created = await getTicketsClient().create({
      token: seller.token,
      title: "Original title",
      quantityTotal: 10,
      unitPriceCents: 4500,
    });

    const updated = await getTicketsClient().update({
      token: seller.token,
      ticketId: created.id,
      title: "Rescheduled title",
      unitPriceCents: 5200,
      expectedVersion: created.version,
    });

    expect(updated.title).toBe("Rescheduled title");
    expect(updated.unitPriceCents).toBe(5200);
    expect(updated.version).toBe(2);
    expect(updated.quantityTotal).toBe(10);
    expect(updated.quantityAvailable).toBe(10);

    const [row] = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, created.id));
    expect(row?.title).toBe("Rescheduled title");
    expect(row?.unitPriceCents).toBe(5200);
    expect(row?.version).toBe(2);

    const outbox = await getTicketsDb()
      .sql`SELECT subject, payload FROM tickets.outbox WHERE subject = 'tickets.updated.v1'`.values();
    expect(outbox).toHaveLength(1);

    const payload = outbox[0]?.[1] as Record<string, unknown>;
    expect(payload["ticketId"]).toBe(created.id);
    expect(payload["title"]).toBe("Rescheduled title");
    expect(payload["unitPriceCents"]).toBe(5200);
    expect(payload["version"]).toBe(2);
  });

  it("rejects an edit when seats are held by an order (CONFLICT reserved)", async () => {
    const seller = await signUpSeller(`reserved-${randomTag()}@example.com`);
    const created = await getTicketsClient().create({
      token: seller.token,
      title: "Held title",
      quantityTotal: 4,
      unitPriceCents: 3000,
    });

    await getTicketsClient().reserve({ ticketId: created.id, quantity: 1 });

    const edit = getTicketsClient().update({
      token: seller.token,
      ticketId: created.id,
      title: "Should not apply",
      unitPriceCents: 9999,
      expectedVersion: created.version,
    });

    await expect(edit).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "reserved" } });

    const [row] = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, created.id));
    expect(row?.title).toBe("Held title");
    expect(row?.unitPriceCents).toBe(3000);
  });

  it("rejects a stale edit whose expectedVersion no longer matches", async () => {
    const seller = await signUpSeller(`stale-${randomTag()}@example.com`);
    const created = await getTicketsClient().create({
      token: seller.token,
      title: "First title",
      quantityTotal: 5,
      unitPriceCents: 1000,
    });

    await getTicketsClient().update({
      token: seller.token,
      ticketId: created.id,
      title: "Second title",
      unitPriceCents: 2000,
      expectedVersion: created.version,
    });

    const stale = getTicketsClient().update({
      token: seller.token,
      ticketId: created.id,
      title: "Third title",
      unitPriceCents: 3000,
      expectedVersion: created.version,
    });

    await expect(stale).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "version_conflict" },
    });
  });

  it("rejects an edit from a seller who does not own the ticket (NOT_FOUND)", async () => {
    const owner = await signUpSeller(`owner-${randomTag()}@example.com`);
    const other = await signUpSeller(`intruder-${randomTag()}@example.com`);
    const created = await getTicketsClient().create({
      token: owner.token,
      title: "Owned title",
      quantityTotal: 5,
      unitPriceCents: 1000,
    });

    const edit = getTicketsClient().update({
      token: other.token,
      ticketId: created.id,
      title: "Hijacked",
      unitPriceCents: 1,
      expectedVersion: created.version,
    });

    await expect(edit).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

function randomTag(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe.skipIf(!dockerAvailable)("tickets list — filter / sort / pagination", () => {
  async function seed(): Promise<string> {
    const seller = await signUpSeller("seller-list@example.com");

    const specs = [
      { title: "Aphex Twin @ Warehouse", unitPriceCents: 4500 },
      { title: "Squarepusher @ Fabric", unitPriceCents: 6000 },
      { title: "Aphex Twin @ Fuji Rock", unitPriceCents: 3000 },
      { title: "Boards of Canada @ Barrowland", unitPriceCents: 9000 },
      { title: "Autechre @ Berghain", unitPriceCents: 7000 },
    ];

    for (const spec of specs) {
      await getTicketsClient().create({
        token: seller.token,
        title: spec.title,
        quantityTotal: 10,
        unitPriceCents: spec.unitPriceCents,
      });
    }

    return seller.token;
  }

  it("filters by title with q (case-insensitive, contains)", async () => {
    await seed();

    const { items } = await getTicketsClient().list({ q: "aphex" });

    expect(items).toHaveLength(2);
    expect(items.every((t) => t.title.toLowerCase().includes("aphex"))).toBe(true);
  });

  it("excludes sold-out rows when availableOnly is set", async () => {
    await seed();

    const [target] = await getTicketsDb()
      .db.select()
      .from(ticketsTable)
      .where(eq(ticketsTable.title, "Autechre @ Berghain"));
    await getTicketsDb()
      .db.update(ticketsTable)
      .set({ quantityAvailable: 0 })
      .where(eq(ticketsTable.id, target!.id));

    const { items } = await getTicketsClient().list({ availableOnly: true });

    expect(items.map((t) => t.title)).not.toContain("Autechre @ Berghain");
    expect(items).toHaveLength(4);
  });

  it("sorts by price ascending and descending", async () => {
    await seed();

    const asc = await getTicketsClient().list({ sort: "price_asc" });
    const ascPrices = asc.items.map((t) => t.unitPriceCents);
    expect(ascPrices).toEqual([...ascPrices].sort((a, b) => a - b));

    const desc = await getTicketsClient().list({ sort: "price_desc" });
    const descPrices = desc.items.map((t) => t.unitPriceCents);
    expect(descPrices).toEqual([...descPrices].sort((a, b) => b - a));
  });

  it("returns newest in non-increasing createdAt order", async () => {
    await seed();

    const { items } = await getTicketsClient().list({ sort: "newest" });

    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.createdAt >= items[i]!.createdAt).toBe(true);
    }
  });

  it("paginates with cursor: disjoint pages, full coverage, null on the last page", async () => {
    await seed();

    const page1 = await getTicketsClient().list({ sort: "price_asc", limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await getTicketsClient().list({
      sort: "price_asc",
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items).toHaveLength(2);

    const page3 = await getTicketsClient().list({
      sort: "price_asc",
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const allIds = [...page1.items, ...page2.items, ...page3.items].map((t) => t.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it("rejects a cursor reused under a different sort", async () => {
    await seed();

    const page1 = await getTicketsClient().list({ sort: "price_asc", limit: 2 });

    const wrongSort = getTicketsClient().list({
      sort: "newest",
      limit: 2,
      cursor: page1.nextCursor!,
    });

    await expect(wrongSort).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
