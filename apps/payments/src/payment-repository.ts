import { ORPCError } from "@orpc/server";
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
    .returning();

  if (!inserted) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "payment insert returned no row" });
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
