import { ORPCError, os } from "@orpc/server";
import { type } from "arktype";
import { eq } from "drizzle-orm";

import { type AuthSessionClient, requireSession } from "@tix/contracts/auth-client";
import { paymentIntentStatus } from "@tix/contracts/payments";
import type { DbClient } from "@tix/db-core/client";

import { recordPayment } from "./payment-repository.ts";
import { orderReadModel, type paymentsTables } from "./payments-schema.ts";
import type { PaymentIntentClient } from "./stripe-payment-intent.ts";

const tokenInput = type({
  token: "string >= 1",
});

const createInput = tokenInput.and({
  orderId: "string.uuid",
  paymentMethodId: "string >= 1",
});

const createOutput = type({
  id: "string.uuid",
  status: paymentIntentStatus,
});

const DEFAULT_CURRENCY = "usd";
const PAYABLE_ORDER_STATUS = "created";

export type PaymentsRouterDeps = {
  db: DbClient<typeof paymentsTables>;
  authClient: AuthSessionClient;
  paymentIntentClient: PaymentIntentClient;
};

export function createPaymentsRouter(deps: PaymentsRouterDeps) {
  const { db, authClient, paymentIntentClient } = deps;

  const create = os
    .input(createInput)
    .output(createOutput)
    .handler(async ({ input }) => {
      const session = await requireSession(authClient, input.token);

      const [order] = await db.db
        .select()
        .from(orderReadModel)
        .where(eq(orderReadModel.id, input.orderId));

      if (!order) {
        throw new ORPCError("NOT_FOUND", { message: "order not found" });
      }

      if (order.userId !== session.user.id) {
        throw new ORPCError("FORBIDDEN", { message: "order belongs to another user" });
      }

      if (order.status !== PAYABLE_ORDER_STATUS) {
        throw new ORPCError("CONFLICT", {
          status: 409,
          message: "order is not payable",
          data: { reason: "not_payable" as const, status: order.status },
        });
      }

      // Stripe charge sits outside the DB tx on purpose: PaymentIntent has
      // network latency we don't want holding a row lock. If the DB write below
      // fails after Stripe succeeds, a retry with the same orderId hits Stripe's
      // 24h idempotency cache and returns the original intent — so we can recover
      // without double-charging.
      const intent = await paymentIntentClient.createPaymentIntent({
        orderId: order.id,
        amountCents: order.priceCents,
        currency: DEFAULT_CURRENCY,
        paymentMethodId: input.paymentMethodId,
      });

      const recorded = await db.db.transaction((tx) =>
        recordPayment(tx, {
          orderId: order.id,
          userId: session.user.id,
          stripeId: intent.stripeId,
          amountCents: order.priceCents,
          currency: DEFAULT_CURRENCY,
          status: intent.status,
        }),
      );

      return { id: recorded.id, status: recorded.status };
    });

  return { create };
}

export type PaymentsRouter = ReturnType<typeof createPaymentsRouter>;
