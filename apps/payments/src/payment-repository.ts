import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { v7 as uuidv7 } from "uuid";

import { PAYMENT_CREATED_V1 } from "@tix/contracts/subjects";
import { enqueueEvent } from "@tix/db-core/outbox";

import { payments, paymentsOutbox } from "./payments-schema.ts";

type AnyDb = PostgresJsDatabase<Record<string, unknown>>;

export type RecordPaymentArgs = {
  orderId: string;
  userId: string;
  stripeId: string;
  amountCents: number;
  currency: string;
  status: string;
};

export type RecordedPayment = {
  id: string;
  status: string;
};

export async function recordPayment(tx: AnyDb, args: RecordPaymentArgs): Promise<RecordedPayment> {
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

  if (!inserted) throw new Error("payment insert returned no row");

  await enqueueEvent(tx, paymentsOutbox, {
    subject: PAYMENT_CREATED_V1,
    eventId: uuidv7(),
    payload: {
      id: inserted.id,
      orderId: inserted.orderId,
      stripeId: inserted.stripeId,
      amountCents: inserted.amount,
      currency: inserted.currency,
      userId: inserted.userId,
      version: inserted.version,
      createdAt: inserted.createdAt.toISOString(),
    },
  });

  return { id: inserted.id, status: inserted.status };
}
