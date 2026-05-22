import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { createRouterClient } from "@orpc/server";
import { ArkErrors } from "arktype";
import { createAuth } from "auth/instance";
import { createAuthRouter } from "auth/router";
import { authTables } from "auth/schema";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthRouterClient } from "@tix/contracts/auth";
import { createInProcessAuthSessionClient } from "@tix/contracts/auth-client";
import { paymentCreatedV1 } from "@tix/contracts/payments";
import { PAYMENT_CREATED_V1 } from "@tix/contracts/subjects";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { startOutboxRelay, type RunningOutboxRelay } from "@tix/db-core/outbox";
import { createConsumer, createPublisher, type RunningConsumer } from "@tix/messaging/jetstream";
import { dockerAvailable } from "@tix/test-helpers/docker-available";
import { requireValue } from "@tix/test-helpers/require-value";

import {
  orderReadModel as orderReadModelTable,
  payments as paymentsTable,
  paymentsOutbox as paymentsOutboxTable,
  paymentsTables,
} from "./payments-schema.ts";
import { createPaymentsRouter } from "./router.ts";
import type { PaymentIntentClient } from "./stripe-payment-intent.ts";

const TEST_SECRET = "test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod";
const TEST_BASE_URL = "http://localhost:4004";

const authMigrations = fileURLToPath(new URL("../../auth/drizzle", import.meta.url));
const paymentsMigrations = fileURLToPath(new URL("../drizzle", import.meta.url));

type PaymentsDbClient = DbClient<typeof paymentsTables>;
type AuthDbClient = DbClient<typeof authTables>;

let pgContainer: StartedTestContainer | undefined;
let natsContainer: StartedTestContainer | undefined;
let nats: NatsConnection | undefined;
let paymentsDb: PaymentsDbClient | undefined;
let authDb: AuthDbClient | undefined;
let authClient: AuthRouterClient | undefined;
let authSessionClient: ReturnType<typeof createInProcessAuthSessionClient> | undefined;
let relay: RunningOutboxRelay | undefined;
let streamName: string | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "payments_publish_e2e",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/payments_publish_e2e`;

  authDb = createDbClient("auth", pgUrl, { schema: authTables });
  await migrate(authDb.db, { migrationsFolder: authMigrations });

  paymentsDb = createDbClient("payments", pgUrl, { schema: paymentsTables });
  await migrate(paymentsDb.db, { migrationsFolder: paymentsMigrations });

  const auth = createAuth({ db: authDb.db, secret: TEST_SECRET, baseURL: TEST_BASE_URL });
  const authRouter = createAuthRouter({ auth });
  authClient = createRouterClient(authRouter);
  authSessionClient = createInProcessAuthSessionClient(authClient);

  const natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;
  nats = await connect({ servers: natsUrl });

  streamName = `S_${randomUUID().replace(/-/g, "")}`;
  const manager = await jetstreamManager(nats);
  await manager.streams.add({
    name: streamName,
    subjects: [PAYMENT_CREATED_V1],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
  });

  const publisher = createPublisher(nats);
  relay = startOutboxRelay(paymentsDb.db, paymentsOutboxTable, publisher.publish, {
    pollIntervalMs: 50,
  });
}, 180_000);

afterAll(async () => {
  await relay?.stop();
  await nats?.close();
  await paymentsDb?.close();
  await authDb?.close();
  await natsContainer?.stop();
  await pgContainer?.stop();
});

beforeEach(async () => {
  if (!paymentsDb || !authDb) return;
  await paymentsDb.sql`TRUNCATE TABLE payments.payments, payments.order_read_model, payments.outbox, payments.inbox RESTART IDENTITY CASCADE`;
  await authDb.sql`TRUNCATE TABLE auth.session, auth.account, auth.user RESTART IDENTITY CASCADE`;
});

function buildClient(paymentIntentClient: PaymentIntentClient) {
  const router = createPaymentsRouter({
    db: requireValue(paymentsDb, "paymentsDb"),
    authClient: requireValue(authSessionClient, "authSessionClient"),
    paymentIntentClient,
  });

  return createRouterClient(router);
}

async function signUpBuyer(): Promise<{ userId: string; token: string }> {
  const result = await requireValue(authClient, "authClient").signUp({
    email: `buyer-${randomUUID()}@example.com`,
    password: "correct-horse-battery",
    name: "buyer",
  });

  return { userId: result.userId, token: result.token };
}

async function seedOrder(buyerId: string, priceCents: number): Promise<string> {
  const orderId = randomUUID();
  await requireValue(paymentsDb, "paymentsDb")
    .db.insert(orderReadModelTable)
    .values({ id: orderId, version: 1, userId: buyerId, priceCents, status: "created" });

  return orderId;
}

describe.skipIf(!dockerAvailable)("payments.create → payment.created.v1 on NATS", () => {
  it("delivers a schema-valid payment.created.v1 to a subscriber within 2s", async () => {
    const nc = requireValue(nats, "nats");
    const stream = requireValue(streamName, "streamName");

    const buyer = await signUpBuyer();
    const orderId = await seedOrder(buyer.userId, 4_500);

    const createPaymentIntent = vi
      .fn<PaymentIntentClient["createPaymentIntent"]>()
      .mockResolvedValue({
        stripeId: "pi_3OqVuk2eZvKYlo2C1Tt5KvP3",
        status: "succeeded",
      });

    let resolveEvent!: (args: { eventId: string; payload: unknown }) => void;
    const received = new Promise<{ eventId: string; payload: unknown }>((r) => {
      resolveEvent = r;
    });

    const group = `g-${randomUUID().replace(/-/g, "")}`;
    const consumer: RunningConsumer = await createConsumer(nc, {
      stream,
      subjectFilter: PAYMENT_CREATED_V1,
      group,
      schema: paymentCreatedV1,
      handler: ({ eventId, payload }) => {
        if (payload.orderId === orderId) resolveEvent({ eventId, payload });
      },
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const client = buildClient({ createPaymentIntent });
      const result = await client.create({
        token: buyer.token,
        orderId,
        paymentMethodId: "pm_card_visa",
      });

      const observed = await Promise.race([
        received,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("did not receive payment.created.v1 within 2s")),
            2_000,
          );
        }),
      ]);

      const validated = paymentCreatedV1(observed.payload);
      expect(validated instanceof ArkErrors).toBe(false);

      expect(observed.payload).toMatchObject({
        id: result.id,
        orderId,
        stripeId: "pi_3OqVuk2eZvKYlo2C1Tt5KvP3",
        amountCents: 4_500,
        currency: "usd",
        userId: buyer.userId,
        version: 1,
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      await consumer.stop();
    }
  }, 30_000);

  it("emits no Payment row, no outbox row, and no event when Stripe returns a non-succeeded status", async () => {
    const nc = requireValue(nats, "nats");
    const stream = requireValue(streamName, "streamName");
    const db = requireValue(paymentsDb, "paymentsDb");

    const buyer = await signUpBuyer();
    const orderId = await seedOrder(buyer.userId, 3_300);

    const createPaymentIntent = vi
      .fn<PaymentIntentClient["createPaymentIntent"]>()
      .mockResolvedValue({
        stripeId: "pi_3OqNotSucceeded00000ABCDE",
        status: "requires_payment_method",
      });

    // Subscribe before driving the mutation so a (mis-)published event would
    // be observed — this is the proof that nothing reaches the broker.
    let observed = false;
    const group = `g-${randomUUID().replace(/-/g, "")}`;
    const consumer: RunningConsumer = await createConsumer(nc, {
      stream,
      subjectFilter: PAYMENT_CREATED_V1,
      group,
      schema: paymentCreatedV1,
      handler: ({ payload }) => {
        if (payload.orderId === orderId) observed = true;
      },
    });

    try {
      const client = buildClient({ createPaymentIntent });
      await expect(
        client.create({
          token: buyer.token,
          orderId,
          paymentMethodId: "pm_card_visa",
        }),
      ).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT", status: 422 });

      // Wait long enough for several 50ms relay ticks to have fired so a
      // mis-enqueued event would have made it through by now.
      await new Promise((r) => setTimeout(r, 500));

      const paymentRows = await db.db
        .select()
        .from(paymentsTable)
        .where(eq(paymentsTable.orderId, orderId));
      expect(paymentRows).toHaveLength(0);

      const outboxRows = await db.db
        .select()
        .from(paymentsOutboxTable)
        .where(eq(paymentsOutboxTable.subject, PAYMENT_CREATED_V1));
      expect(outboxRows).toHaveLength(0);

      expect(observed).toBe(false);
    } finally {
      await consumer.stop();
    }
  }, 30_000);
});
