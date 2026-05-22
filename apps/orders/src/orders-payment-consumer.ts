import { type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { type Logger } from "pino";

import { paymentCreatedV1 } from "@tix/contracts/payments";
import { PAYMENT_CREATED_V1 } from "@tix/contracts/subjects";
import { type DbClient } from "@tix/db-core/client";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { createConsumer, type RunningConsumer } from "@tix/messaging/jetstream";

import { orders, ordersInbox, type ordersTables } from "./orders-schema.ts";
import { transition, type Status } from "./state-machine.ts";

export const ORDERS_PAYMENT_CREATED_CONSUMER_GROUP = "orders-payment-created";

export type StartOrdersPaymentCreatedConsumerArgs = {
  db: DbClient<typeof ordersTables>;
  nats: NatsConnection;
  stream: string;
  logger?: Logger;
  ackWaitMs?: number;
};

export async function startOrdersPaymentCreatedConsumer(
  args: StartOrdersPaymentCreatedConsumerArgs,
): Promise<RunningConsumer> {
  const { db, nats, stream, logger, ackWaitMs } = args;

  const loggerOpt = logger === undefined ? {} : { logger };
  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return createConsumer(nats, {
    stream,
    subjectFilter: PAYMENT_CREATED_V1,
    group: ORDERS_PAYMENT_CREATED_CONSUMER_GROUP,
    schema: paymentCreatedV1,
    ...loggerOpt,
    ...ackWaitOpt,
    handler: async ({ eventId, subject, payload }) => {
      await db.db.transaction(async (tx) => {
        const result = await withInboxDedupe(tx, ordersInbox, { eventId, subject }, async () => {
          const [order] = await tx.select().from(orders).where(eq(orders.id, payload.orderId));
          if (!order) {
            logger?.warn(
              { eventId, orderId: payload.orderId },
              "payment.created.v1 for unknown order; skipping",
            );
            return;
          }

          const status = order.status as Status;
          const next = transition(status, { kind: "payment_confirmed" });
          if (!next.ok) {
            logger?.info(
              { eventId, orderId: order.id, status, reason: next.reason },
              "payment.created.v1 ignored by FSM",
            );
            return;
          }

          const updated = await updateVersioned(
            tx,
            orders,
            { id: order.id, version: order.version },
            { status: next.next },
          );
          if (updated.rowsAffected === 0) {
            // Order moved to a terminal state under us (e.g. expired right
            // before payment.created arrived). Inbox row commits regardless,
            // so the event won't be re-delivered.
            logger?.warn(
              { eventId, orderId: order.id, version: order.version },
              "order version changed under us; skipping payment_confirmed",
            );
            return;
          }
        });

        if (result.deduped) {
          logger?.info(
            { eventId, orderId: payload.orderId },
            "skipping duplicate payment.created.v1",
          );
        }
      });
    },
  });
}
