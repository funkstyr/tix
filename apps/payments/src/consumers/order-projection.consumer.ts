import { type NatsConnection } from "@nats-io/transport-node";
import { Effect } from "effect";

import { orderCancelledV1, orderCreatedV1 } from "@tix/contracts/orders";
import { ORDER_CANCELLED_V1, ORDER_CREATED_V1 } from "@tix/contracts/subjects";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { createConsumer, type RunningConsumer } from "@tix/messaging/jetstream";
import { externalParent } from "@tix/observability/otel-trace";
import { withTimeout } from "@tix/observability/resilience";

import { orderReadModel, paymentsInbox } from "../domain/schema.ts";
import type { PaymentsRuntime } from "../runtime/runtime.ts";
import { Database } from "../runtime/services.ts";

export const PAYMENTS_ORDER_CREATED_CONSUMER_GROUP = "payments-order-created";
export const PAYMENTS_ORDER_CANCELLED_CONSUMER_GROUP = "payments-order-cancelled";

export type StartPaymentsOrderCreatedConsumerArgs = {
  runtime: PaymentsRuntime;
  nats: NatsConnection;
  stream: string;
  ackWaitMs?: number;
};

export type StartPaymentsOrderCancelledConsumerArgs = StartPaymentsOrderCreatedConsumerArgs;

// Seeds the payments read-model when an Order is created. Created orders always start at
// version 1; `onConflictDoNothing` makes a redelivery a no-op even before the inbox dedupe
// commits.
export async function startPaymentsOrderCreatedConsumer(
  args: StartPaymentsOrderCreatedConsumerArgs,
): Promise<RunningConsumer> {
  const { runtime, nats, stream, ackWaitMs } = args;

  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return createConsumer(nats, {
    stream,
    subjectFilter: ORDER_CREATED_V1,
    group: PAYMENTS_ORDER_CREATED_CONSUMER_GROUP,
    schema: orderCreatedV1,
    ...ackWaitOpt,
    handler: ({ eventId, subject, payload, traceContext }) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;

          const result = yield* withTimeout(
            "payments.db.project_order_created",
            Effect.tryPromise(() =>
              db.db.transaction((tx) =>
                withInboxDedupe(tx, paymentsInbox, { eventId, subject }, async () => {
                  // Inbox dedupe above is the primary guard. `onConflictDoNothing` is a
                  // belt-and-suspenders for the case where the inbox and the projection
                  // get out of sync (e.g. a test truncating only the inbox).
                  await tx
                    .insert(orderReadModel)
                    .values({
                      id: payload.orderId,
                      // `created` is the first state, so version starts at 1; later
                      // order.* events bump it via updateVersioned.
                      version: 1,
                      userId: payload.buyerId,
                      priceCents: payload.priceCents,
                      status: "created",
                    })
                    .onConflictDoNothing({ target: orderReadModel.id });
                }),
              ),
            ),
          );

          if (result.deduped) {
            yield* Effect.logInfo("skipping duplicate order.created.v1").pipe(
              Effect.annotateLogs({ eventId, orderId: payload.orderId }),
            );
          }
        }).pipe(
          Effect.withSpan("payments.consume.order_created", {
            parent: externalParent(traceContext),
          }),
        ),
      ),
  });
}

// Marks the read-model row cancelled. `updateVersioned` matches WHERE version =
// event.version - 1 and bumps to event.version on success: stale events
// (event.version <= local version) and out-of-order future events both miss the WHERE
// clause and become no-ops. The inbox row still commits, so a stale redelivery isn't
// retried forever.
export async function startPaymentsOrderCancelledConsumer(
  args: StartPaymentsOrderCancelledConsumerArgs,
): Promise<RunningConsumer> {
  const { runtime, nats, stream, ackWaitMs } = args;

  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return createConsumer(nats, {
    stream,
    subjectFilter: ORDER_CANCELLED_V1,
    group: PAYMENTS_ORDER_CANCELLED_CONSUMER_GROUP,
    schema: orderCancelledV1,
    ...ackWaitOpt,
    handler: ({ eventId, subject, payload, traceContext }) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;

          const result = yield* withTimeout(
            "payments.db.project_order_cancelled",
            Effect.tryPromise(() =>
              db.db.transaction((tx) =>
                withInboxDedupe(tx, paymentsInbox, { eventId, subject }, async () => {
                  const updated = await updateVersioned(
                    tx,
                    orderReadModel,
                    { id: payload.orderId, version: payload.version - 1 },
                    { status: "cancelled" },
                  );

                  return { applied: updated.rowsAffected > 0 };
                }),
              ),
            ),
          );

          if (result.deduped) {
            yield* Effect.logInfo("skipping duplicate order.cancelled.v1").pipe(
              Effect.annotateLogs({ eventId, orderId: payload.orderId }),
            );
          } else if (!result.result.applied) {
            yield* Effect.logInfo(
              "order.cancelled.v1 ignored (stale, future, or unknown order)",
            ).pipe(
              Effect.annotateLogs({
                eventId,
                orderId: payload.orderId,
                eventVersion: payload.version,
              }),
            );
          }
        }).pipe(
          Effect.withSpan("payments.consume.order_cancelled", {
            parent: externalParent(traceContext),
          }),
        ),
      ),
  });
}
