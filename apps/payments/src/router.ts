import { ORPCError, os } from "@orpc/server";
import { type } from "arktype";
import { eq } from "drizzle-orm";

import { type AuthSessionClient, requireSession } from "@tix/contracts/auth-client";
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
  status: "string",
});

const DEFAULT_CURRENCY = "usd";

export type PaymentsRouterDeps = {
  db: DbClient<typeof paymentsTables>;
  authClient: AuthSessionClient;
  paymentIntentClient: PaymentIntentClient;
};

export function createPaymentsRouter(deps: PaymentsRouterDeps) {
  const { db, authClient, paymentIntentClient } = deps;

  const base = os;

  const create = base
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
