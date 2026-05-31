import { type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { Clock, Effect } from "effect";
import { v7 as uuidv7 } from "uuid";

import { paymentCreatedV1 } from "@tix/contracts/payments";
import { ORDER_COMPLETED_V1, PAYMENT_CREATED_V1 } from "@tix/contracts/subjects";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { enqueueEvent } from "@tix/db-core/outbox";
import { createConsumer, type RunningConsumer } from "@tix/messaging/jetstream";

import { orders, ordersInbox, ordersOutbox } from "./orders-schema.ts";
import type { OrdersRuntime } from "./runtime.ts";
import { Database, InfraLogger } from "./services.ts";
import { transition } from "./state-machine.ts";

export const ORDERS_PAYMENT_CREATED_CONSUMER_GROUP = "orders-payment-created";

export type StartOrdersPaymentCreatedConsumerArgs = {
  runtime: OrdersRuntime;
  nats: NatsConnection;
  stream: string;
  ackWaitMs?: number;
};

export async function startOrdersPaymentCreatedConsumer(
  args: StartOrdersPaymentCreatedConsumerArgs,
): Promise<RunningConsumer> {
  const { runtime, nats, stream, ackWaitMs } = args;

  const logger = runtime.runSync(InfraLogger);
  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return createConsumer(nats, {
    stream,
    subjectFilter: PAYMENT_CREATED_V1,
    group: ORDERS_PAYMENT_CREATED_CONSUMER_GROUP,
    schema: paymentCreatedV1,
    logger,
    ...ackWaitOpt,
    handler: ({ eventId, subject, payload }) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;
          const nowMs = yield* Clock.currentTimeMillis;

          const result = yield* Effect.tryPromise(() =>
            db.db.transaction((tx) =>
              withInboxDedupe(tx, ordersInbox, { eventId, subject }, async () => {
                const [order] = await tx
                  .select()
                  .from(orders)
                  .where(eq(orders.id, payload.orderId));
                if (!order) {
                  logger.warn(
                    { eventId, orderId: payload.orderId },
                    "payment.created.v1 for unknown order; skipping",
                  );
                  return;
                }

                const next = transition(order.status, { kind: "payment_confirmed" });
                if (!next.ok) {
                  logger.info(
                    { eventId, orderId: order.id, status: order.status, reason: next.reason },
                    "payment.created.v1 ignored by FSM",
                  );
                  return;
                }

                const nextVersion = order.version + 1;
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
                  logger.warn(
                    { eventId, orderId: order.id, version: order.version },
                    "order version changed under us; skipping payment_confirmed",
                  );
                  return;
                }

                await enqueueEvent(tx, ordersOutbox, {
                  subject: ORDER_COMPLETED_V1,
                  eventId: uuidv7(),
                  payload: {
                    orderId: order.id,
                    version: nextVersion,
                    completedAt: new Date(nowMs).toISOString(),
                  },
                });
              }),
            ),
          );

          if (result.deduped) {
            yield* Effect.logInfo("skipping duplicate payment.created.v1").pipe(
              Effect.annotateLogs({ eventId, orderId: payload.orderId }),
            );
          }
        }),
      ),
  });
}
