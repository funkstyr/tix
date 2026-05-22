import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { v7 as uuidv7 } from "uuid";

import { paymentCreatedV1, type PaymentIntentStatus } from "@tix/contracts/payments";
import { PAYMENT_CREATED_V1 } from "@tix/contracts/subjects";
import { enqueueEvent } from "@tix/db-core/outbox";

import { payments, paymentsOutbox, type paymentsTables } from "./payments-schema.ts";

type PaymentsDb = PostgresJsDatabase<typeof paymentsTables>;

export type RecordPaymentArgs = {
  orderId: string;
  userId: string;
  stripeId: string;
  amountCents: number;
  currency: string;
  status: PaymentIntentStatus;
};

export type RecordedPayment = {
  id: string;
  status: PaymentIntentStatus;
};

export async function recordPayment(
  tx: PaymentsDb,
  args: RecordPaymentArgs,
): Promise<RecordedPayment> {
  // ON CONFLICT (order_id) DO NOTHING + a SELECT fallback is the app-level
  // idempotency seam. Sequential retries and concurrent double-clicks both
  // converge to one row + one outbox entry. Stripe's idempotency-key cache
  // (keyed on orderId) handles the charge side; this handles our writes.
  const [inserted] = await tx
    .insert(payments)
    .values({
      orderId: args.orderId,
      userId: args.userId,
      stripeId: args.stripeId,
      amount: args.amountCents,
      currency: args.currency,
      status: args.status,
    })
    .onConflictDoNothing({ target: payments.orderId })
    .returning();

  if (!inserted) {
    const [existing] = await tx.select().from(payments).where(eq(payments.orderId, args.orderId));

    if (!existing) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "payment conflict resolved but row missing",
      });
    }

    return { id: existing.id, status: existing.status as PaymentIntentStatus };
  }

  const payload = paymentCreatedV1.assert({
    id: inserted.id,
    orderId: inserted.orderId,
    stripeId: inserted.stripeId,
    amountCents: inserted.amount,
    currency: inserted.currency,
    userId: inserted.userId,
    version: inserted.version,
    createdAt: inserted.createdAt.toISOString(),
  });

  await enqueueEvent(tx, paymentsOutbox, {
    subject: PAYMENT_CREATED_V1,
    eventId: uuidv7(),
    payload,
  });

  return { id: inserted.id, status: args.status };
}
