import { expect, it } from "@effect/vitest";
import { Effect, Metric } from "effect";

import type { AuthSession } from "@tix/contracts/auth";
import type { AuthSessionClient } from "@tix/contracts/auth-client";
import type { PaymentIntentStatus } from "@tix/contracts/payments";

import {
  OrderForbidden,
  OrderNotFound,
  OrderNotPayable,
  PaymentIntentNotSucceeded,
} from "../domain/errors.ts";
import { paymentsFailedTotal, paymentsSucceededTotal } from "../runtime/metrics.ts";
import type { PaymentsDb } from "../runtime/services.ts";
import { createPaymentsTestLayer } from "../runtime/test-runtime.ts";
import type { PaymentIntentClient } from "../stripe-payment-intent.ts";
import { createPaymentProgram } from "./router.ts";

const BUYER_ID = "buyer-1";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const PAYMENT_ID = "22222222-2222-4222-8222-222222222222";

const INPUT = { token: "t", orderId: ORDER_ID, paymentMethodId: "pm_card_visa" };

function stubAuth(userId = BUYER_ID): AuthSessionClient {
  const session = { user: { id: userId } } as AuthSession;

  return { getSession: () => Promise.resolve(session) };
}

function stubIntent(result: {
  stripeId: string;
  status: PaymentIntentStatus;
}): PaymentIntentClient {
  return { createPaymentIntent: () => Promise.resolve(result) };
}

type OrderRow = { id: string; userId: string; priceCents: number; status: string };

const CREATED_ORDER: OrderRow = {
  id: ORDER_ID,
  userId: BUYER_ID,
  priceCents: 4_500,
  status: "created",
};

// A fake db whose `select` returns the given order rows and whose `transaction` runs the
// recordPayment island against a fake tx. The chain returned from `values` satisfies both
// the payment insert (`onConflictDoNothing().returning()`) and the outbox enqueue (an
// awaitable insert) without a real database.
function fakeDb(orderRows: readonly OrderRow[]): PaymentsDb {
  const tx = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        // The outbox enqueue (`enqueueEvent`) awaits a bare insert and its row carries a
        // `subject`; the payment insert chains `.onConflictDoNothing().returning()`.
        if ("subject" in row) return Promise.resolve();

        const inserted = { ...row, id: PAYMENT_ID, version: 1, createdAt: new Date(0) };

        return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([inserted]) }) };
      },
    }),
  };

  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(orderRows) }) }),
    transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };

  return { db } as unknown as PaymentsDb;
}

it.effect("fails with OrderNotFound when the order is unknown", () =>
  Effect.gen(function* () {
    const layer = createPaymentsTestLayer({ db: fakeDb([]), authClient: stubAuth() });

    const error = yield* createPaymentProgram(INPUT).pipe(Effect.provide(layer), Effect.flip);

    expect(error).toBeInstanceOf(OrderNotFound);
  }),
);

it.effect("fails with OrderForbidden when the order belongs to another user", () =>
  Effect.gen(function* () {
    const layer = createPaymentsTestLayer({
      db: fakeDb([{ ...CREATED_ORDER, userId: "someone-else" }]),
      authClient: stubAuth(),
    });

    const error = yield* createPaymentProgram(INPUT).pipe(Effect.provide(layer), Effect.flip);

    expect(error).toBeInstanceOf(OrderForbidden);
  }),
);

it.effect("fails with OrderNotPayable when the order is not in 'created'", () =>
  Effect.gen(function* () {
    const layer = createPaymentsTestLayer({
      db: fakeDb([{ ...CREATED_ORDER, status: "cancelled" }]),
      authClient: stubAuth(),
    });

    const error = yield* createPaymentProgram(INPUT).pipe(Effect.provide(layer), Effect.flip);

    expect(error).toBeInstanceOf(OrderNotPayable);
  }),
);

// A non-succeeded intent maps to the domain tag and increments the failed-charge counter
// (no Payment row is written — that path is covered by the integration test).
it.effect("fails with PaymentIntentNotSucceeded and counts a failed charge", () =>
  Effect.gen(function* () {
    const layer = createPaymentsTestLayer({
      db: fakeDb([CREATED_ORDER]),
      authClient: stubAuth(),
      paymentIntentClient: stubIntent({ stripeId: "pi_x", status: "requires_payment_method" }),
    });

    const before = (yield* Metric.value(paymentsFailedTotal)).count;

    const error = yield* createPaymentProgram(INPUT).pipe(Effect.provide(layer), Effect.flip);

    const after = (yield* Metric.value(paymentsFailedTotal)).count;

    expect(error).toBeInstanceOf(PaymentIntentNotSucceeded);
    expect(after - before).toBe(1);
  }),
);

// Metrics are a process-global registry, so assert on the delta a single run produces
// rather than an absolute value.
it.effect("records a succeeded payment and counts it", () =>
  Effect.gen(function* () {
    const layer = createPaymentsTestLayer({
      db: fakeDb([CREATED_ORDER]),
      authClient: stubAuth(),
      paymentIntentClient: stubIntent({ stripeId: "pi_ok", status: "succeeded" }),
    });

    const before = (yield* Metric.value(paymentsSucceededTotal)).count;

    const result = yield* createPaymentProgram(INPUT).pipe(Effect.provide(layer));

    const after = (yield* Metric.value(paymentsSucceededTotal)).count;

    expect(result.status).toBe("succeeded");
    expect(after - before).toBe(1);
  }),
);
