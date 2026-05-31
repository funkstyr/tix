import { type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { Clock, Effect } from "effect";
import { v7 as uuidv7 } from "uuid";

import { orderExpiredV1 } from "@tix/contracts/orders";
import { ORDER_EXPIRED_V1, ORDER_RESERVATION_RELEASED_V1 } from "@tix/contracts/subjects";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { enqueueEvent } from "@tix/db-core/outbox";
import { createConsumer, type RunningConsumer } from "@tix/messaging/jetstream";

import { orders, ordersInbox, ordersOutbox } from "../domain/schema.ts";
import { transition } from "../domain/state-machine.ts";
import type { OrdersRuntime } from "../runtime/runtime.ts";
import { Database, InfraLogger } from "../runtime/services.ts";

export const ORDERS_EXPIRATION_CONSUMER_GROUP = "orders-expiration";

export type StartOrdersExpiredConsumerArgs = {
  runtime: OrdersRuntime;
  nats: NatsConnection;
  stream: string;
  ackWaitMs?: number;
};

export async function startOrdersExpiredConsumer(
  args: StartOrdersExpiredConsumerArgs,
): Promise<RunningConsumer> {
  const { runtime, nats, stream, ackWaitMs } = args;

  // The JetStream loop and the transaction island still log through pino (kept
  // until ADR-0008's final cleanup slice); the Effect program logs through the
  // runtime's logger.
  const logger = runtime.runSync(InfraLogger);
  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return createConsumer(nats, {
    stream,
    subjectFilter: ORDER_EXPIRED_V1,
    group: ORDERS_EXPIRATION_CONSUMER_GROUP,
    schema: orderExpiredV1,
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
                    "order.expired.v1 for unknown order; skipping",
                  );
                  return;
                }

                const next = transition(order.status, { kind: "deadline_passed" });
                if (!next.ok) {
                  logger.info(
                    { eventId, orderId: order.id, status: order.status, reason: next.reason },
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
                  // A concurrent writer (buyer cancel, payment) moved the row to a
                  // terminal state between our read and write, where `order.expired`
                  // is correctly a no-op. The inbox row commits regardless, so the
                  // event won't be re-delivered.
                  logger.warn(
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
                    releasedAt: new Date(nowMs).toISOString(),
                  },
                });
              }),
            ),
          );

          if (result.deduped) {
            yield* Effect.logInfo("skipping duplicate order.expired.v1").pipe(
              Effect.annotateLogs({ eventId, orderId: payload.orderId }),
            );
          }
        }),
      ),
  });
}
