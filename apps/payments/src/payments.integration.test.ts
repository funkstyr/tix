import { createRouterClient } from "@orpc/server";
import { createAuth } from "auth/instance";
import { createAuthRouter } from "auth/router";
import { authTables } from "auth/schema";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthRouterClient } from "@tix/contracts/auth";
import { createInProcessAuthSessionClient } from "@tix/contracts/auth-client";
import { createDbClient, type DbClient } from "@tix/db-core/client";
import { dockerAvailable } from "@tix/test-helpers/docker-available";
import { requireValue } from "@tix/test-helpers/require-value";

import { recordPayment } from "./payment-repository.ts";
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
let paymentsDb: PaymentsDbClient | undefined;
let authDb: AuthDbClient | undefined;
let authClient: AuthRouterClient | undefined;
let authSessionClient: ReturnType<typeof createInProcessAuthSessionClient> | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "payments_router_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const host = pgContainer.getHost();
  const port = pgContainer.getMappedPort(5432);
  const url = `postgres://postgres:postgres@${host}:${port}/payments_router_test`;

  authDb = createDbClient("auth", url, { schema: authTables });
  await migrate(authDb.db, { migrationsFolder: authMigrations });

  paymentsDb = createDbClient("payments", url, { schema: paymentsTables });
  await migrate(paymentsDb.db, { migrationsFolder: paymentsMigrations });

  const auth = createAuth({ db: authDb.db, secret: TEST_SECRET, baseURL: TEST_BASE_URL });
  const authRouter = createAuthRouter({ auth });
  authClient = createRouterClient(authRouter);
  authSessionClient = createInProcessAuthSessionClient(authClient);
}, 180_000);

afterAll(async () => {
  await paymentsDb?.close();
  await authDb?.close();
  await pgContainer?.stop();
});

beforeEach(async () => {
  if (!paymentsDb || !authDb) return;

  await paymentsDb.sql`TRUNCATE TABLE payments.payments, payments.order_read_model, payments.outbox, payments.inbox RESTART IDENTITY CASCADE`;
  await authDb.sql`TRUNCATE TABLE auth.session, auth.account, auth.user RESTART IDENTITY CASCADE`;
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe.skipIf(!dockerAvailable)("payments.create — happy path", () => {
  it("charges via Stripe, writes a Payment row, and enqueues payment.created.v1", async () => {
    const buyer = await signUpBuyer();
    const orderId = await seedOrder(buyer.userId, 4_500);

    const createPaymentIntent = vi
      .fn<PaymentIntentClient["createPaymentIntent"]>()
      .mockResolvedValue({
        stripeId: "pi_3OqVuk2eZvKYlo2C1Tt5KvP3",
        status: "succeeded",
      });

    const client = buildClient({ createPaymentIntent });

    const result = await client.create({
      token: buyer.token,
      orderId,
      paymentMethodId: "pm_card_visa",
    });

    expect(result.status).toBe("succeeded");

    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(createPaymentIntent).toHaveBeenCalledWith({
      orderId,
      amountCents: 4_500,
      currency: "usd",
      paymentMethodId: "pm_card_visa",
    });

    const db = requireValue(paymentsDb, "paymentsDb");
    const [row] = await db.db.select().from(paymentsTable).where(eq(paymentsTable.id, result.id));
    expect(row).toMatchObject({
      orderId,
      userId: buyer.userId,
      stripeId: "pi_3OqVuk2eZvKYlo2C1Tt5KvP3",
      amount: 4_500,
      currency: "usd",
      status: "succeeded",
    });

    const outboxRows = await db.db
      .select()
      .from(paymentsOutboxTable)
      .where(eq(paymentsOutboxTable.subject, "payment.created.v1"));
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.payload).toMatchObject({
      id: result.id,
      orderId,
      stripeId: "pi_3OqVuk2eZvKYlo2C1Tt5KvP3",
      amountCents: 4_500,
      currency: "usd",
      userId: buyer.userId,
      version: 1,
    });
    expect(outboxRows[0]?.sentAt).toBeNull();
  });

  it("writes the Payment row and outbox entry in the same transaction", async () => {
    const buyer = await signUpBuyer();
    const orderId = await seedOrder(buyer.userId, 1_200);

    const db = requireValue(paymentsDb, "paymentsDb");

    await expect(
      db.db.transaction(async (tx) => {
        await recordPayment(tx, {
          orderId,
          userId: buyer.userId,
          stripeId: "pi_3OqAtomicTest456789ABCDEF",
          amountCents: 1_200,
          currency: "usd",
          status: "succeeded",
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const paymentRows = await db.db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.orderId, orderId));
    expect(paymentRows).toHaveLength(0);

    const outboxRows = await db.db
      .select()
      .from(paymentsOutboxTable)
      .where(eq(paymentsOutboxTable.subject, "payment.created.v1"));
    expect(outboxRows).toHaveLength(0);
  });
});

describe.skipIf(!dockerAvailable)("payments.create — idempotency", () => {
  it("sequential retries with the same orderId converge to one Payment row + one outbox entry", async () => {
    const buyer = await signUpBuyer();
    const orderId = await seedOrder(buyer.userId, 4_500);

    const createPaymentIntent = vi
      .fn<PaymentIntentClient["createPaymentIntent"]>()
      .mockResolvedValue({
        stripeId: "pi_3OqVuk2eZvKYlo2C1Tt5KvP3",
        status: "succeeded",
      });

    const client = buildClient({ createPaymentIntent });

    const first = await client.create({
      token: buyer.token,
      orderId,
      paymentMethodId: "pm_card_visa",
    });

    const second = await client.create({
      token: buyer.token,
      orderId,
      paymentMethodId: "pm_card_visa",
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe(first.status);

    // Stripe is called on every retry by design — its idempotency-key cache
    // (keyed on orderId) dedupes the actual charge server-side. Our local
    // writes are deduped by UNIQUE(order_id) in payments.
    expect(createPaymentIntent).toHaveBeenCalledTimes(2);

    const db = requireValue(paymentsDb, "paymentsDb");

    const paymentRows = await db.db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.orderId, orderId));
    expect(paymentRows).toHaveLength(1);

    const outboxRows = await db.db
      .select()
      .from(paymentsOutboxTable)
      .where(eq(paymentsOutboxTable.subject, "payment.created.v1"));
    expect(outboxRows).toHaveLength(1);
  });

  it("concurrent retries with the same orderId converge to one Payment row + one outbox entry", async () => {
    const buyer = await signUpBuyer();
    const orderId = await seedOrder(buyer.userId, 4_500);

    const createPaymentIntent = vi
      .fn<PaymentIntentClient["createPaymentIntent"]>()
      .mockResolvedValue({
        stripeId: "pi_3OqConcurrent1234567890AB",
        status: "succeeded",
      });

    const client = buildClient({ createPaymentIntent });

    const [first, second] = await Promise.all([
      client.create({ token: buyer.token, orderId, paymentMethodId: "pm_card_visa" }),
      client.create({ token: buyer.token, orderId, paymentMethodId: "pm_card_visa" }),
    ]);

    expect(second.id).toBe(first.id);
    expect(second.status).toBe(first.status);

    const db = requireValue(paymentsDb, "paymentsDb");

    const paymentRows = await db.db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.orderId, orderId));
    expect(paymentRows).toHaveLength(1);

    const outboxRows = await db.db
      .select()
      .from(paymentsOutboxTable)
      .where(eq(paymentsOutboxTable.subject, "payment.created.v1"));
    expect(outboxRows).toHaveLength(1);
  });
});

describe.skipIf(!dockerAvailable)("payments.create — error paths", () => {
  async function assertNoSideEffects(orderId: string) {
    const db = requireValue(paymentsDb, "paymentsDb");
    const paymentRows = await db.db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.orderId, orderId));
    expect(paymentRows).toHaveLength(0);

    const outboxRows = await db.db
      .select()
      .from(paymentsOutboxTable)
      .where(eq(paymentsOutboxTable.subject, "payment.created.v1"));
    expect(outboxRows).toHaveLength(0);
  }

  it("rejects with NOT_FOUND when the order is unknown", async () => {
    const buyer = await signUpBuyer();
    const orderId = randomUUID();
    const createPaymentIntent = vi.fn<PaymentIntentClient["createPaymentIntent"]>();
    const client = buildClient({ createPaymentIntent });

    const call = client.create({
      token: buyer.token,
      orderId,
      paymentMethodId: "pm_card_visa",
    });

    await expect(call).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(createPaymentIntent).not.toHaveBeenCalled();
    await assertNoSideEffects(orderId);
  });

  it("rejects with FORBIDDEN when the order belongs to another user", async () => {
    const owner = await signUpBuyer();
    const intruder = await signUpBuyer();
    const orderId = await seedOrder(owner.userId, 2_500);

    const createPaymentIntent = vi.fn<PaymentIntentClient["createPaymentIntent"]>();
    const client = buildClient({ createPaymentIntent });

    const call = client.create({
      token: intruder.token,
      orderId,
      paymentMethodId: "pm_card_visa",
    });

    await expect(call).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(createPaymentIntent).not.toHaveBeenCalled();
    await assertNoSideEffects(orderId);
  });

  it.each(["awaiting_payment", "cancelled", "expired", "complete"] as const)(
    "rejects with CONFLICT when the order is %s",
    async (status) => {
      const buyer = await signUpBuyer();
      const orderId = randomUUID();
      await requireValue(paymentsDb, "paymentsDb").db.insert(orderReadModelTable).values({
        id: orderId,
        version: 2,
        userId: buyer.userId,
        priceCents: 3_300,
        status,
      });

      const createPaymentIntent = vi.fn<PaymentIntentClient["createPaymentIntent"]>();
      const client = buildClient({ createPaymentIntent });

      const call = client.create({
        token: buyer.token,
        orderId,
        paymentMethodId: "pm_card_visa",
      });

      await expect(call).rejects.toMatchObject({
        code: "CONFLICT",
        status: 409,
        data: { reason: "not_payable", status },
      });
      expect(createPaymentIntent).not.toHaveBeenCalled();
      await assertNoSideEffects(orderId);
    },
  );

  it("does not write a Payment row or outbox entry when Stripe throws", async () => {
    const buyer = await signUpBuyer();
    const orderId = await seedOrder(buyer.userId, 7_700);

    const createPaymentIntent = vi
      .fn<PaymentIntentClient["createPaymentIntent"]>()
      .mockRejectedValue(new Error("stripe network error"));

    const client = buildClient({ createPaymentIntent });

    const call = client.create({
      token: buyer.token,
      orderId,
      paymentMethodId: "pm_card_visa",
    });

    await expect(call).rejects.toThrow("stripe network error");
    await assertNoSideEffects(orderId);
  });

  it.each([
    "canceled",
    "processing",
    "requires_action",
    "requires_capture",
    "requires_confirmation",
    "requires_payment_method",
  ] as const)(
    "rejects with UNPROCESSABLE_CONTENT and writes nothing when Stripe returns %s",
    async (status) => {
      const buyer = await signUpBuyer();
      const orderId = await seedOrder(buyer.userId, 6_600);

      const createPaymentIntent = vi
        .fn<PaymentIntentClient["createPaymentIntent"]>()
        .mockResolvedValue({ stripeId: "pi_3OqNonSucceeded000000ABCD", status });

      const client = buildClient({ createPaymentIntent });

      const call = client.create({
        token: buyer.token,
        orderId,
        paymentMethodId: "pm_card_visa",
      });

      await expect(call).rejects.toMatchObject({
        code: "UNPROCESSABLE_CONTENT",
        status: 422,
        data: { reason: "intent_not_succeeded", status },
      });
      expect(createPaymentIntent).toHaveBeenCalledTimes(1);
      await assertNoSideEffects(orderId);
    },
  );
});
