import { type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { Clock, Effect } from "effect";
import { v7 as uuidv7 } from "uuid";

import { orderExpiredV1 } from "@tix/contracts/orders";
import { ORDER_EXPIRED_V1, ORDER_RESERVATION_RELEASED_V1 } from "@tix/contracts/subjects";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { enqueueEvent } from "@tix/db-core/outbox";
import { consumer, runScopedConsumer, type RunningConsumer } from "@tix/messaging/jetstream";
import { domainAttributes, SpanAttr } from "@tix/observability/attributes";
import { externalParent } from "@tix/observability/otel-trace";
import { withTimeout } from "@tix/observability/resilience";

import { orders, ordersInbox, ordersOutbox } from "../domain/schema.ts";
import { transition } from "../domain/state-machine.ts";
import type { OrdersRuntime } from "../runtime/runtime.ts";
import { Database } from "../runtime/services.ts";

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

  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return runScopedConsumer(
    runtime,
    consumer(nats, {
      stream,
      subjectFilter: ORDER_EXPIRED_V1,
      group: ORDERS_EXPIRATION_CONSUMER_GROUP,
      schema: orderExpiredV1,
      ...ackWaitOpt,
      handler: ({ eventId, subject, payload, traceContext }) =>
        Effect.gen(function* () {
          const db = yield* Database;
          const nowMs = yield* Clock.currentTimeMillis;

          const result = yield* withTimeout(
            "orders.db.expire_order",
            Effect.tryPromise(() =>
              db.db.transaction((tx) =>
                withInboxDedupe(tx, ordersInbox, { eventId, subject }, async () => {
                  const [order] = await tx
                    .select()
                    .from(orders)
                    .where(eq(orders.id, payload.orderId));
                  if (!order) return { kind: "unknown_order" as const };

                  const next = transition(order.status, { kind: "deadline_passed" });
                  if (!next.ok) {
                    return {
                      kind: "fsm_ignored" as const,
                      status: order.status,
                      reason: next.reason,
                    };
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
                    return { kind: "version_conflict" as const, version: order.version };
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

                  return { kind: "released" as const };
                }),
              ),
            ),
          );

          if (result.deduped) {
            yield* Effect.logInfo("skipping duplicate order.expired.v1").pipe(
              Effect.annotateLogs({ eventId, orderId: payload.orderId }),
            );

            return;
          }

          const outcome = result.result;
          switch (outcome.kind) {
            case "unknown_order":
              yield* Effect.logWarning("order.expired.v1 for unknown order; skipping").pipe(
                Effect.annotateLogs({ eventId, orderId: payload.orderId }),
              );
              break;

            case "fsm_ignored":
              yield* Effect.logInfo("order.expired.v1 ignored by FSM").pipe(
                Effect.annotateLogs({
                  eventId,
                  orderId: payload.orderId,
                  status: outcome.status,
                  reason: outcome.reason,
                }),
              );
              break;

            case "version_conflict":
              yield* Effect.logWarning("order version changed under us; skipping release").pipe(
                Effect.annotateLogs({
                  eventId,
                  orderId: payload.orderId,
                  version: outcome.version,
                }),
              );
              break;

            case "released":
              break;
          }
        }).pipe(
          Effect.withSpan("orders.consume.order_expired", {
            parent: externalParent(traceContext),
            attributes: domainAttributes({
              [SpanAttr.orderId]: payload.orderId,
              [SpanAttr.messageId]: eventId,
              [SpanAttr.destination]: subject,
            }),
          }),
        ),
    }),
  );
}
