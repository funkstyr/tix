import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { createRouterClient } from "@orpc/server";
import { ArkErrors } from "arktype";
import { createAuth } from "auth/instance";
import { createAuthRouter } from "auth/router";
import { authTables } from "auth/schema";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthRouterClient } from "@tix/contracts/auth";
import { TICKETS_CREATED_V1 } from "@tix/contracts/subjects";
import { ticketCreatedV1 } from "@tix/contracts/tickets";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { startOutboxRelay, type RunningOutboxRelay } from "@tix/db-core/outbox";
import { createConsumer, createPublisher, type RunningConsumer } from "@tix/messaging/jetstream";

import { createInProcessAuthSessionClient } from "./auth-session-client.ts";
import { createTicketsRouter } from "./router.ts";
import { ticketsOutbox, ticketsTables } from "./tickets-schema.ts";

const TEST_SECRET = "test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod";
const TEST_BASE_URL = "http://localhost:4001";
const TEST_SERVICE_TOKEN = "test-service-token";

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

let pgContainer: StartedTestContainer | undefined;
let natsContainer: StartedTestContainer | undefined;
let nats: NatsConnection | undefined;
let ticketsDb: TicketsDbClient | undefined;
let authDb: AuthDbClient | undefined;
let ticketsClient: ReturnType<typeof buildClients>["ticketsClient"] | undefined;
let authClient: AuthRouterClient | undefined;
let relay: RunningOutboxRelay | undefined;
let streamName: string | undefined;

function buildClients(ticketsDb_: TicketsDbClient, authDb_: AuthDbClient) {
  const auth = createAuth({ db: authDb_.db, secret: TEST_SECRET, baseURL: TEST_BASE_URL });
  const authRouter = createAuthRouter({ auth });
  const authRouterClient: AuthRouterClient = createRouterClient(authRouter);
  const authSessionClient = createInProcessAuthSessionClient(authRouterClient);
  const ticketsRouter = createTicketsRouter({
    db: ticketsDb_,
    authClient: authSessionClient,
    serviceToken: TEST_SERVICE_TOKEN,
  });

  return {
    authClient: authRouterClient,
    ticketsClient: createRouterClient(ticketsRouter, {
      context: { serviceToken: TEST_SERVICE_TOKEN },
    }),
  };
}

beforeAll(async () => {
  if (!dockerAvailable) return;

  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "tickets_e2e",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/tickets_e2e`;

  authDb = createDbClient("auth", pgUrl, { schema: authTables });
  await migrate(authDb.db, { migrationsFolder: authMigrations });

  ticketsDb = createDbClient("tickets", pgUrl, { schema: ticketsTables });
  await migrate(ticketsDb.db, { migrationsFolder: ticketsMigrations });

  const clients = buildClients(ticketsDb, authDb);
  ticketsClient = clients.ticketsClient;
  authClient = clients.authClient;

  const natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;
  nats = await connect({ servers: natsUrl });

  streamName = `S_${randomUUID().replace(/-/g, "")}`;
  const manager = await jetstreamManager(nats);
  await manager.streams.add({
    name: streamName,
    subjects: [TICKETS_CREATED_V1],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
  });

  const publisher = createPublisher(nats);
  relay = startOutboxRelay(ticketsDb.db, ticketsOutbox, publisher.publish, {
    pollIntervalMs: 50,
  });
}, 180_000);

afterAll(async () => {
  await relay?.stop();
  await nats?.close();
  await ticketsDb?.close();
  await authDb?.close();
  await natsContainer?.stop();
  await pgContainer?.stop();
});

beforeEach(async () => {
  if (!ticketsDb) return;
  await ticketsDb.sql`TRUNCATE TABLE tickets.tickets, tickets.outbox RESTART IDENTITY CASCADE`;
});

function requireClients(): {
  tickets: NonNullable<typeof ticketsClient>;
  auth: AuthRouterClient;
  nats: NatsConnection;
  stream: string;
} {
  if (!ticketsClient || !authClient || !nats || !streamName) {
    throw new Error("test harness not initialized");
  }

  return { tickets: ticketsClient, auth: authClient, nats, stream: streamName };
}

describe.skipIf(!dockerAvailable)("tickets.create → tickets.created.v1 on NATS", () => {
  it("emits a tickets.created.v1 event that validates the contract schema within 2s", async () => {
    const { tickets, auth, nats: nc, stream } = requireClients();

    const seller = await auth.signUp({
      email: `seller-${randomUUID()}@example.com`,
      password: "correct-horse-battery",
      name: "seller",
    });

    let resolveEvent!: (args: { eventId: string; payload: unknown }) => void;
    const received = new Promise<{ eventId: string; payload: unknown }>((r) => {
      resolveEvent = r;
    });

    const group = `g-${randomUUID().replace(/-/g, "")}`;
    const consumer: RunningConsumer = await createConsumer(nc, {
      stream,
      subjectFilter: TICKETS_CREATED_V1,
      group,
      schema: ticketCreatedV1,
      handler: ({ eventId, payload }) => {
        resolveEvent({ eventId, payload });
      },
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const created = await tickets.create({
        token: seller.token,
        title: "Boards of Canada @ Concorde",
        quantityTotal: 50,
        unitPriceCents: 7500,
      });

      const observed = await Promise.race([
        received,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("did not receive event within 2s")),
            2_000,
          );
        }),
      ]);

      const validated = ticketCreatedV1(observed.payload);
      expect(validated instanceof ArkErrors).toBe(false);

      expect(observed.payload).toMatchObject({
        ticketId: created.id,
        sellerId: seller.userId,
        title: "Boards of Canada @ Concorde",
        quantityTotal: 50,
        unitPriceCents: 7500,
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      await consumer.stop();
    }
  }, 30_000);
});
