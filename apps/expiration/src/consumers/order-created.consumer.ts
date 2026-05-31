import { type NatsConnection } from "@nats-io/transport-node";
import { Effect } from "effect";

import { orderCreatedV1 } from "@tix/contracts/orders";
import { ORDER_CREATED_V1 } from "@tix/contracts/subjects";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { createConsumer, type RunningConsumer } from "@tix/messaging/jetstream";
import { externalParent } from "@tix/observability/otel-trace";
import { withTimeout } from "@tix/observability/resilience";

import { expirationInbox } from "../expiration-schema.ts";
import {
  EXPIRATION_CONSUMER_GROUP,
  EXPIRATION_JOB_NAME,
  type ExpireOrderPayload,
} from "../expire-order-job.ts";
import { expiryDelayMs } from "../expiry-delay.ts";
import type { ExpirationRuntime } from "../runtime/runtime.ts";
import { Database, Scheduler } from "../runtime/services.ts";
import { captureJobTraceparent } from "../trace-job.ts";

export type StartExpirationConsumerArgs = {
  runtime: ExpirationRuntime;
  nats: NatsConnection;
  stream: string;
  ackWaitMs?: number;
};

// Consumes `order.created.v1` and schedules a BullMQ delayed job that fires at the Order's
// `expiresAt`, auto-cancelling it. The inbox dedupes redeliveries; the delayed job's
// `jobId = orderId` makes a duplicate schedule a no-op even before the inbox commits.
//
// The job carries the active trace context (the consume span) so the eventual expiry span
// continues this Order's trace — a delayed job is decoupled from its scheduler much like an
// outbox event is decoupled from its relay, so the carrier rides in the job data.
export async function startExpirationConsumer(
  args: StartExpirationConsumerArgs,
): Promise<RunningConsumer> {
  const { runtime, nats, stream, ackWaitMs } = args;

  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return createConsumer(nats, {
    stream,
    subjectFilter: ORDER_CREATED_V1,
    group: EXPIRATION_CONSUMER_GROUP,
    schema: orderCreatedV1,
    ...ackWaitOpt,
    handler: ({ eventId, subject, payload, traceContext }) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;
          const scheduler = yield* Scheduler;

          const delayMs = yield* expiryDelayMs(payload.expiresAt);
          const traceparent = yield* Effect.sync(() => captureJobTraceparent());

          const job: ExpireOrderPayload = {
            orderId: payload.orderId,
            expiredAt: payload.expiresAt,
            ...(traceparent === undefined ? {} : { traceparent }),
          };

          const result = yield* withTimeout(
            "expiration.db.schedule_expiry",
            Effect.tryPromise(() =>
              db.db.transaction((tx) =>
                withInboxDedupe(tx, expirationInbox, { eventId, subject }, () =>
                  scheduler.scheduleDelayed(EXPIRATION_JOB_NAME, job, delayMs, payload.orderId),
                ),
              ),
            ),
          );

          if (result.deduped) {
            yield* Effect.logInfo("skipping duplicate order.created.v1").pipe(
              Effect.annotateLogs({ eventId, orderId: payload.orderId }),
            );
          }
        }).pipe(
          Effect.withSpan("expiration.consume.order_created", {
            parent: externalParent(traceContext),
            attributes: { orderId: payload.orderId },
          }),
        ),
      ),
  });
}
