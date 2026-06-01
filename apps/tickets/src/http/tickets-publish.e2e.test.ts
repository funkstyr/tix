import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { createRouterClient } from "@orpc/server";
import { ArkErrors } from "arktype";
import { createAuth } from "auth/instance";
import { createAuthRouter } from "auth/router";
import { authTables } from "auth/schema";
import { createAuthTestRuntime } from "auth/test-runtime";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Effect, Fiber } from "effect";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthRouterClient } from "@tix/contracts/auth";
import { createInProcessAuthSessionClient } from "@tix/contracts/auth-client";
import { TICKETS_CREATED_V1 } from "@tix/contracts/subjects";
import { ticketCreatedV1 } from "@tix/contracts/tickets";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { outboxRelay } from "@tix/db-core/outbox";
import {
  consumer,
  createPublisher,
  defaultScopedRunner,
  runScopedConsumer,
  type RunningConsumer,
} from "@tix/messaging/jetstream";

import { ticketsOutbox, ticketsTables } from "../domain/schema.ts";
import { createTicketsTestRuntime } from "../runtime/test-runtime.ts";
import { createTicketsRouter } from "./router.ts";

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

let pgContainer: StartedTestContainer | undefined;
let natsContainer: StartedTestContainer | undefined;
let nats: NatsConnection | undefined;
let ticketsDb: TicketsDbClient | undefined;
let authDb: AuthDbClient | undefined;
let ticketsClient: ReturnType<typeof buildClients>["ticketsClient"] | undefined;
let authClient: AuthRouterClient | undefined;
let relay: { stop: () => Promise<void> } | undefined;
let streamName: string | undefined;

function buildClients(ticketsDb_: TicketsDbClient, authDb_: AuthDbClient) {
  const auth = createAuth({ db: authDb_.db, secret: TEST_SECRET, baseURL: TEST_BASE_URL });
  const authRouter = createAuthRouter(createAuthTestRuntime({ auth }));
  const authRouterClient: AuthRouterClient = createRouterClient(authRouter);
  const authSessionClient = createInProcessAuthSessionClient(authRouterClient);

  const ticketsRuntime = createTicketsTestRuntime({
    db: ticketsDb_,
    authClient: authSessionClient,
    serviceToken: TEST_SERVICE_TOKEN,
  });
  const ticketsRouter = createTicketsRouter(ticketsRuntime);

  return {
    authClient: authRouterClient,
    ticketsClient: createRouterClient(ticketsRouter, {
      context: { otelParent: ROOT_CONTEXT, serviceToken: TEST_SERVICE_TOKEN },
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
  relay = runRelay(ticketsDb.db, ticketsOutbox, publisher.publish, {
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
    const consumerHandle: RunningConsumer = await runScopedConsumer(
      defaultScopedRunner,
      consumer(nc, {
        stream,
        subjectFilter: TICKETS_CREATED_V1,
        group,
        schema: ticketCreatedV1,
        handler: ({ eventId, payload }) =>
          Effect.sync(() => {
            resolveEvent({ eventId, payload });
          }),
      }),
    );

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
      await consumerHandle.stop();
    }
  }, 30_000);
});
