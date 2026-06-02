import { type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { Clock, Effect } from "effect";
import { v7 as uuidv7 } from "uuid";

import { paymentCreatedV1 } from "@tix/contracts/payments";
import { ORDER_COMPLETED_V1, PAYMENT_CREATED_V1 } from "@tix/contracts/subjects";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { enqueueEvent } from "@tix/db-core/outbox";
import { consumer, runScopedConsumer, type RunningConsumer } from "@tix/messaging/jetstream";
import { domainAttributes, SpanAttr } from "@tix/observability/attributes";
import { dbSpan } from "@tix/observability/db-span";
import { externalParent } from "@tix/observability/otel-trace";
import { withTimeout } from "@tix/observability/resilience";

import { orders, ordersInbox, ordersOutbox } from "../domain/schema.ts";
import { transition } from "../domain/state-machine.ts";
import type { OrdersRuntime } from "../runtime/runtime.ts";
import { Database } from "../runtime/services.ts";

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

  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return runScopedConsumer(
    runtime,
    consumer(nats, {
      stream,
      subjectFilter: PAYMENT_CREATED_V1,
      group: ORDERS_PAYMENT_CREATED_CONSUMER_GROUP,
      schema: paymentCreatedV1,
      ...ackWaitOpt,
      handler: ({ eventId, subject, payload, traceContext }) =>
        Effect.gen(function* () {
          const db = yield* Database;
          const nowMs = yield* Clock.currentTimeMillis;

          // The transaction returns a discriminated outcome so the diagnostics that used
          // to log inside the (non-Effect) island now log through Effect — span-correlated.
          const result = yield* dbSpan(
            "consume_payment_created",
            "orders.inbox",
            withTimeout(
              "orders.db.confirm_payment",
              Effect.tryPromise(() =>
                db.db.transaction((tx) =>
                  withInboxDedupe(tx, ordersInbox, { eventId, subject }, async () => {
                    const [order] = await tx
                      .select()
                      .from(orders)
                      .where(eq(orders.id, payload.orderId));
                    if (!order) return { kind: "unknown_order" as const };

                    const next = transition(order.status, { kind: "payment_confirmed" });
                    if (!next.ok) {
                      return {
                        kind: "fsm_ignored" as const,
                        status: order.status,
                        reason: next.reason,
                      };
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
                      return { kind: "version_conflict" as const, version: order.version };
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

                    return { kind: "completed" as const };
                  }),
                ),
              ),
            ),
          );

          if (result.deduped) {
            yield* Effect.logInfo("skipping duplicate payment.created.v1").pipe(
              Effect.annotateLogs({ eventId, orderId: payload.orderId }),
            );

            return;
          }

          const outcome = result.result;
          switch (outcome.kind) {
            case "unknown_order":
              yield* Effect.logWarning("payment.created.v1 for unknown order; skipping").pipe(
                Effect.annotateLogs({ eventId, orderId: payload.orderId }),
              );
              break;

            case "fsm_ignored":
              yield* Effect.logInfo("payment.created.v1 ignored by FSM").pipe(
                Effect.annotateLogs({
                  eventId,
                  orderId: payload.orderId,
                  status: outcome.status,
                  reason: outcome.reason,
                }),
              );
              break;

            case "version_conflict":
              yield* Effect.logWarning(
                "order version changed under us; skipping payment_confirmed",
              ).pipe(
                Effect.annotateLogs({
                  eventId,
                  orderId: payload.orderId,
                  version: outcome.version,
                }),
              );
              break;

            case "completed":
              break;
          }
        }).pipe(
          Effect.withSpan("orders.consume.payment_created", {
            parent: externalParent(traceContext),
            attributes: domainAttributes({
              [SpanAttr.orderId]: payload.orderId,
              [SpanAttr.paymentId]: payload.id,
              [SpanAttr.messageId]: eventId,
              [SpanAttr.destination]: subject,
            }),
          }),
        ),
    }),
  );
}
