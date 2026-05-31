import { type ConnectionOptions, type Worker } from "bullmq";
import { Clock, Effect, Metric } from "effect";

import { ORDER_EXPIRED_V1 } from "@tix/contracts/subjects";
import { createWorker } from "@tix/messaging/jobs";
import { externalParent } from "@tix/observability/otel-trace";
import { withTimeout } from "@tix/observability/resilience";

import { EXPIRATION_QUEUE, type ExpireOrderPayload } from "../expire-order-job.ts";
import {
  expirationsProcessedTotal,
  expiryDuplicatePublishTotal,
  expiryJobLatencyMs,
} from "../runtime/metrics.ts";
import type { ExpirationRuntime } from "../runtime/runtime.ts";
import { EventPublisher } from "../runtime/services.ts";
import { jobTraceContext } from "../trace-job.ts";

export type StartExpireOrderWorkerArgs = {
  runtime: ExpirationRuntime;
  redis: ConnectionOptions;
};

// The BullMQ worker that fires a scheduled expiry: it publishes `order.expired.v1` so the
// orders service can auto-cancel the Order. A deterministic `msgId` (`expired:<orderId>`)
// lets JetStream drop duplicates when BullMQ retries after a lost ack.
//
// Each execution runs as one span parented to the originating Order's trace (reconstructed
// from the `traceparent` the consumer stored on the job), so an auto-cancel links back to
// the buyer's create-order request. A handler failure rejects the runtime promise, which
// BullMQ surfaces as a job failure and retries (ADR-0008).
export function startExpireOrderWorker(
  args: StartExpireOrderWorkerArgs,
): Worker<ExpireOrderPayload, void> {
  const { runtime, redis } = args;

  return createWorker<ExpireOrderPayload>(redis, {
    queueName: EXPIRATION_QUEUE,
    handler: ({ orderId, expiredAt, traceparent }) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const publisher = yield* EventPublisher;
          const msgId = `expired:${orderId}`;

          const startMs = yield* Clock.currentTimeMillis;
          const { ack } = yield* withTimeout(
            "expiration.publish.order_expired",
            Effect.tryPromise(() =>
              publisher.publish(ORDER_EXPIRED_V1, { orderId, expiredAt }, { msgId }),
            ),
          );
          const endMs = yield* Clock.currentTimeMillis;

          yield* Metric.increment(expirationsProcessedTotal);
          yield* Metric.update(expiryJobLatencyMs, endMs - startMs);
          if (ack.duplicate) yield* Metric.increment(expiryDuplicatePublishTotal);

          yield* Effect.logInfo("order.expired.v1 published").pipe(
            Effect.annotateLogs({ orderId, msgId, duplicate: ack.duplicate }),
          );
        }).pipe(
          Effect.withSpan("expiration.job.expire_order", {
            parent: externalParent(jobTraceContext(traceparent)),
            attributes: { orderId },
          }),
        ),
      ),
  });
}
