import { createRouterClient } from "@orpc/server";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createTicketsRouter } from "tickets/router";
import { ticketsTables } from "tickets/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthFixture, type AuthFixture } from "@tix/auth-test-fixture/fixture";
import type { CurrentUser } from "@tix/contracts/auth";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { dockerAvailable } from "@tix/test-helpers/docker-available";

import type { DownstreamClients } from "./downstream-clients.ts";
import { createGatewayRouter, type GatewayInitialContext } from "./gateway-router.ts";

const TEST_BASE_URL = "http://localhost:4000";
const TEST_SERVICE_TOKEN = "test-service-token";

const ticketsMigrations = fileURLToPath(new URL("../../tickets/drizzle", import.meta.url));

type TicketsDbClient = DbClient<typeof ticketsTables>;

let container: StartedTestContainer | undefined;
let authFixture: AuthFixture | undefined;
let ticketsDb: TicketsDbClient | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "gateway_router_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const databaseUrl = `postgres://postgres:postgres@${host}:${port}/gateway_router_test`;

  authFixture = await createAuthFixture({ databaseUrl, baseUrl: TEST_BASE_URL });

  ticketsDb = createDbClient("tickets", databaseUrl, { schema: ticketsTables });
  await migrate(ticketsDb.db, { migrationsFolder: ticketsMigrations });
}, 120_000);

afterAll(async () => {
  await ticketsDb?.close();
  await authFixture?.close();
  await container?.stop();
});

beforeEach(async () => {
  if (!ticketsDb || !authFixture) return;

  await ticketsDb.sql`TRUNCATE TABLE tickets.tickets, tickets.outbox RESTART IDENTITY CASCADE`;
  await authFixture.truncate();
});

function getAuthFixture(): AuthFixture {
  if (!authFixture) throw new Error("authFixture not initialized");

  return authFixture;
}

function getTicketsDb(): TicketsDbClient {
  if (!ticketsDb) throw new Error("ticketsDb not initialized");

  return ticketsDb;
}

function buildTicketsClients() {
  const ticketsRouter = createTicketsRouter({
    db: getTicketsDb(),
    authClient: getAuthFixture().authSessionClient,
    serviceToken: TEST_SERVICE_TOKEN,
  });

  const directClient = createRouterClient(ticketsRouter, {
    context: { serviceToken: TEST_SERVICE_TOKEN },
  });

  // Adapter from the in-process router client to the DownstreamRouterClient
  // shape the gateway composer expects. In-process calls don't carry a cookie,
  // so the second `options` argument is discarded.
  const downstreamTickets: DownstreamClients["tickets"] = {
    create: (input) => directClient.create(input),
    reserve: (input) => directClient.reserve(input),
    getById: (input) => directClient.getById(input),
    list: (input) => directClient.list(input),
  };

  return { directClient, downstreamTickets };
}

function buildGatewayClient(opts: {
  downstreamTickets: DownstreamClients["tickets"];
  getCurrentUser?: (req: Request) => Promise<CurrentUser | null>;
}) {
  const clients = {
    tickets: opts.downstreamTickets,
    orders: {} as DownstreamClients["orders"],
    payments: {} as DownstreamClients["payments"],
    auth: {} as DownstreamClients["auth"],
  } satisfies DownstreamClients;

  const getCurrentUser = opts.getCurrentUser ?? (async () => null);

  const router = createGatewayRouter({ clients, getCurrentUser });
  const context: GatewayInitialContext = {
    request: new Request("http://gateway.test/rpc/tickets/list"),
    cookieHeader: null,
  };

  return createRouterClient(router, { context });
}

async function signUpSeller(email: string): Promise<{ userId: string; token: string }> {
  const [name = "seller"] = email.split("@");
  const result = await getAuthFixture().authClient.signUp({
    email,
    password: "correct-horse-battery",
    name,
  });

  return { userId: result.userId, token: result.token };
}

describe.skipIf(!dockerAvailable)("gateway router (in-process tickets)", () => {
  it("tickets.list returns the same shape as a direct call to the tickets service", async () => {
    const seller = await signUpSeller("seller@example.com");
    const { directClient, downstreamTickets } = buildTicketsClients();

    await directClient.create({
      token: seller.token,
      title: "Aphex Twin @ Warehouse",
      quantityTotal: 50,
      unitPriceCents: 4500,
    });
    await directClient.create({
      token: seller.token,
      title: "Boards of Canada @ Concorde",
      quantityTotal: 80,
      unitPriceCents: 7500,
    });

    const direct = await directClient.list({});

    const gatewayClient = buildGatewayClient({ downstreamTickets });
    const throughGateway = await gatewayClient.tickets.list({});

    expect(throughGateway).toEqual(direct);
    expect(throughGateway.items).toHaveLength(2);
  });

  it("honors the limit input through the gateway", async () => {
    const seller = await signUpSeller("seller2@example.com");
    const { directClient, downstreamTickets } = buildTicketsClients();

    // Sequential to keep createdAt ordering deterministic; uuidv7 only orders
    // within the same ms and these inserts can land in the same tick.
    await directClient.create({
      token: seller.token,
      title: "t-0",
      quantityTotal: 1,
      unitPriceCents: 100,
    });
    await directClient.create({
      token: seller.token,
      title: "t-1",
      quantityTotal: 1,
      unitPriceCents: 100,
    });
    await directClient.create({
      token: seller.token,
      title: "t-2",
      quantityTotal: 1,
      unitPriceCents: 100,
    });

    const gatewayClient = buildGatewayClient({ downstreamTickets });
    const limited = await gatewayClient.tickets.list({ limit: 2 });

    expect(limited.items).toHaveLength(2);
  });

  it("invokes getCurrentUser with the per-request Request so currentUser flows into oRPC context", async () => {
    const { downstreamTickets } = buildTicketsClients();
    const getCurrentUser = vi
      .fn<(req: Request) => Promise<CurrentUser | null>>()
      .mockResolvedValue({
        id: "user-1",
        email: "buyer@example.com",
        name: "Buyer",
      });

    const gatewayClient = buildGatewayClient({ downstreamTickets, getCurrentUser });
    await gatewayClient.tickets.list({});

    expect(getCurrentUser).toHaveBeenCalledTimes(1);
    expect(getCurrentUser.mock.calls[0]?.[0]).toBeInstanceOf(Request);
  });
});
