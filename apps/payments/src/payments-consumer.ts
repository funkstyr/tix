import { type NatsConnection } from "@nats-io/transport-node";
import { type Logger } from "pino";

import { orderCreatedV1 } from "@tix/contracts/orders";
import { ORDER_CREATED_V1 } from "@tix/contracts/subjects";
import { type DbClient } from "@tix/db-core/client";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { createConsumer, type RunningConsumer } from "@tix/messaging/jetstream";

import { orderReadModel, paymentsInbox, type paymentsTables } from "./payments-schema.ts";

export const PAYMENTS_ORDER_CREATED_CONSUMER_GROUP = "payments-order-created";

export type StartPaymentsOrderCreatedConsumerArgs = {
  db: DbClient<typeof paymentsTables>;
  nats: NatsConnection;
  stream: string;
  logger?: Logger;
  ackWaitMs?: number;
};

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
          // Upsert keeps the row idempotent if the inbox row was lost (e.g. a
          // truncate during testing) but the read-model row survives — without
          // ON CONFLICT we'd raise on the second-ever delivery.
          await tx
            .insert(orderReadModel)
            .values({
              id: payload.orderId,
              version: 1,
              userId: payload.buyerId,
              price: payload.priceCents,
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
