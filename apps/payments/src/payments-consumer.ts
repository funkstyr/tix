import { type NatsConnection } from "@nats-io/transport-node";
import { type Logger } from "pino";

import { orderCancelledV1, orderCreatedV1 } from "@tix/contracts/orders";
import { ORDER_CANCELLED_V1, ORDER_CREATED_V1 } from "@tix/contracts/subjects";
import { type DbClient } from "@tix/db-core/client";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { createConsumer, type RunningConsumer } from "@tix/messaging/jetstream";

import { orderReadModel, paymentsInbox, type paymentsTables } from "./payments-schema.ts";

export const PAYMENTS_ORDER_CREATED_CONSUMER_GROUP = "payments-order-created";
export const PAYMENTS_ORDER_CANCELLED_CONSUMER_GROUP = "payments-order-cancelled";

export type StartPaymentsOrderCreatedConsumerArgs = {
  db: DbClient<typeof paymentsTables>;
  nats: NatsConnection;
  stream: string;
  logger?: Logger;
  ackWaitMs?: number;
};

export type StartPaymentsOrderCancelledConsumerArgs = StartPaymentsOrderCreatedConsumerArgs;

export async function startPaymentsOrderCreatedConsumer(
  args: StartPaymentsOrderCreatedConsumerArgs,
): Promise<RunningConsumer> {
  const { db, nats, stream, logger, ackWaitMs } = args;

  const loggerOpt = logger === undefined ? {} : { logger };
  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return createConsumer(nats, {
    stream,
    subjectFilter: ORDER_CREATED_V1,
    group: PAYMENTS_ORDER_CREATED_CONSUMER_GROUP,
    schema: orderCreatedV1,
    ...loggerOpt,
    ...ackWaitOpt,
    handler: async ({ eventId, subject, payload }) => {
      await db.db.transaction(async (tx) => {
        const result = await withInboxDedupe(tx, paymentsInbox, { eventId, subject }, async () => {
          // Inbox dedupe above is the primary guard. `onConflictDoNothing` is a
          // belt-and-suspenders for the case where the inbox and the projection
          // get out of sync (e.g. a test truncating only the inbox).
          await tx
            .insert(orderReadModel)
            .values({
              id: payload.orderId,
              // `created` is the first state, so version starts at 1; later
              // order.* events will bump it via updateVersioned.
              version: 1,
              userId: payload.buyerId,
              priceCents: payload.priceCents,
              status: "created",
            })
            .onConflictDoNothing({ target: orderReadModel.id });
        });

        if (result.deduped) {
          logger?.info(
            { eventId, orderId: payload.orderId },
            "skipping duplicate order.created.v1",
          );
        }
      });
    },
  });
}

export async function startPaymentsOrderCancelledConsumer(
  args: StartPaymentsOrderCancelledConsumerArgs,
): Promise<RunningConsumer> {
  const { db, nats, stream, logger, ackWaitMs } = args;

  const loggerOpt = logger === undefined ? {} : { logger };
  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return createConsumer(nats, {
    stream,
    subjectFilter: ORDER_CANCELLED_V1,
    group: PAYMENTS_ORDER_CANCELLED_CONSUMER_GROUP,
    schema: orderCancelledV1,
    ...loggerOpt,
    ...ackWaitOpt,
    handler: async ({ eventId, subject, payload }) => {
      await db.db.transaction(async (tx) => {
        const result = await withInboxDedupe(tx, paymentsInbox, { eventId, subject }, async () => {
          // `updateVersioned` matches WHERE version = event.version - 1 and bumps to
          // event.version on success. That's the optimistic check: stale events
          // (event.version <= local version) and out-of-order future events both
          // miss the WHERE clause and become no-ops. The inbox row still commits,
          // so a stale redelivery isn't retried forever.
          const updated = await updateVersioned(
            tx,
            orderReadModel,
            { id: payload.orderId, version: payload.version - 1 },
            { status: "cancelled" },
          );

          if (updated.rowsAffected === 0) {
            logger?.info(
              { eventId, orderId: payload.orderId, eventVersion: payload.version },
              "order.cancelled.v1 ignored (stale, future, or unknown order)",
            );
          }
        });

        if (result.deduped) {
          logger?.info(
            { eventId, orderId: payload.orderId },
            "skipping duplicate order.cancelled.v1",
          );
        }
      });
    },
  });
}
