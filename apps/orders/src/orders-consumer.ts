import { type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { type Logger } from "pino";
import { v7 as uuidv7 } from "uuid";

import { orderExpiredV1 } from "@tix/contracts/orders";
import { ORDER_EXPIRED_V1, ORDER_RESERVATION_RELEASED_V1 } from "@tix/contracts/subjects";
import { type DbClient } from "@tix/db-core/client";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { enqueueEvent } from "@tix/db-core/outbox";
import { createConsumer, type RunningConsumer } from "@tix/messaging/jetstream";

import { orders, ordersInbox, ordersOutbox, type ordersTables } from "./orders-schema.ts";
import { transition, type Status } from "./state-machine.ts";

export const ORDERS_EXPIRATION_CONSUMER_GROUP = "orders-expiration";

export type StartOrdersExpiredConsumerArgs = {
  db: DbClient<typeof ordersTables>;
  nats: NatsConnection;
  stream: string;
  logger?: Logger;
  ackWaitMs?: number;
};

export async function startOrdersExpiredConsumer(
  args: StartOrdersExpiredConsumerArgs,
): Promise<RunningConsumer> {
  const { db, nats, stream, logger, ackWaitMs } = args;

  const loggerOpt = logger === undefined ? {} : { logger };
  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return createConsumer(nats, {
    stream,
    subjectFilter: ORDER_EXPIRED_V1,
    group: ORDERS_EXPIRATION_CONSUMER_GROUP,
    schema: orderExpiredV1,
    ...loggerOpt,
    ...ackWaitOpt,
    handler: async ({ eventId, subject, payload }) => {
      await db.db.transaction(async (tx) => {
        const result = await withInboxDedupe(tx, ordersInbox, { eventId, subject }, async () => {
          const [order] = await tx.select().from(orders).where(eq(orders.id, payload.orderId));
          if (!order) {
            logger?.warn(
              { eventId, orderId: payload.orderId },
              "order.expired.v1 for unknown order; skipping",
            );
            return;
          }

          const status = order.status as Status;
          const next = transition(status, { kind: "deadline_passed" });
          if (!next.ok) {
            logger?.info(
              { eventId, orderId: order.id, status, reason: next.reason },
              "order.expired.v1 ignored by FSM",
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
            // Safe today because `deadline_passed` is the only wired transition:
            // any concurrent writer must have already moved the row to a terminal
            // state, where `order.expired` is correctly a no-op. Revisit when
            // more transitions land — the inbox row commits regardless, so the
            // event won't be re-delivered.
            logger?.warn(
              { eventId, orderId: order.id, version: order.version },
              "order version changed under us; skipping release",
            );
            return;
          }

          await enqueueEvent(tx, ordersOutbox, {
            subject: ORDER_RESERVATION_RELEASED_V1,
            eventId: uuidv7(),
            payload: {
              orderId: order.id,
              ticketId: order.ticketId,
              quantity: order.quantity,
              releasedAt: new Date().toISOString(),
            },
          });
        });

        if (result.deduped) {
          logger?.info(
            { eventId, orderId: payload.orderId },
            "skipping duplicate order.expired.v1",
          );
        }
      });
    },
  });
}
