import { createRouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PAYMENT_INTENT_STATUSES } from "@tix/contracts/payments";
import { dockerAvailable } from "@tix/test-helpers/docker-available";
import { requireValue } from "@tix/test-helpers/require-value";

import { recordPayment } from "./payment-repository.ts";
import {
  orderReadModel as orderReadModelTable,
  payments as paymentsTable,
  paymentsOutbox as paymentsOutboxTable,
} from "./payments-schema.ts";
import {
  type PaymentsTestStack,
  seedOrder as fixtureSeedOrder,
  signUpBuyer as fixtureSignUpBuyer,
  startPaymentsTestStack,
  stopPaymentsTestStack,
  truncatePaymentsTestStack,
} from "./payments-test-fixtures.ts";
import { createPaymentsRouter } from "./router.ts";
import type { PaymentIntentClient } from "./stripe-payment-intent.ts";

let stack: PaymentsTestStack | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;
  stack = await startPaymentsTestStack("payments_router_test");
}, 180_000);

afterAll(async () => {
  if (stack) await stopPaymentsTestStack(stack);
});

beforeEach(async () => {
  if (stack) await truncatePaymentsTestStack(stack);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buildClient(paymentIntentClient: PaymentIntentClient) {
  const s = requireValue(stack, "stack");
  const router = createPaymentsRouter({
    db: s.paymentsDb,
    authClient: s.authSessionClient,
    paymentIntentClient,
  });

  return createRouterClient(router);
}

async function signUpBuyer(): Promise<{ userId: string; token: string }> {
  return fixtureSignUpBuyer(requireValue(stack, "stack").authClient);
}

async function seedOrder(buyerId: string, priceCents: number): Promise<string> {
  return fixtureSeedOrder(requireValue(stack, "stack").paymentsDb, buyerId, priceCents);
}

function getPaymentsDb() {
  return requireValue(stack, "stack").paymentsDb;
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

    const db = getPaymentsDb();
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

    const db = getPaymentsDb();

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

    const db = getPaymentsDb();

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

    const db = getPaymentsDb();

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
    const db = getPaymentsDb();
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
      await getPaymentsDb().db.insert(orderReadModelTable).values({
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

  const nonSucceededStatuses = PAYMENT_INTENT_STATUSES.filter((s) => s !== "succeeded");

  it.each(nonSucceededStatuses)(
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
