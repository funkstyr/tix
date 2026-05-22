import { type NatsConnection } from "@nats-io/transport-node";
import { type ConnectionOptions, type Worker } from "bullmq";
import { type Logger } from "pino";

import { orderCreatedV1 } from "@tix/contracts/orders";
import { ORDER_CREATED_V1, ORDER_EXPIRED_V1 } from "@tix/contracts/subjects";
import { type DbClient } from "@tix/db-core/client";
import { withInboxDedupe } from "@tix/db-core/inbox";
import {
  createConsumer,
  createPublisher,
  type Publisher,
  type RunningConsumer,
} from "@tix/messaging/jetstream";
import { createScheduler, createWorker, type DelayedScheduler } from "@tix/messaging/jobs";

import { expirationInbox, type expirationTables } from "./expiration-schema.ts";

export const EXPIRATION_QUEUE = "expiration";
export const EXPIRATION_JOB_NAME = "expire-order";
export const EXPIRATION_CONSUMER_GROUP = "expiration";

// At-least-once publish of order.expired.v1 without a service-local outbox (see #14):
// BullMQ retries the job on failure, and JetStream dedupes via a deterministic msgId
// (`expired:<orderId>`) so a lost ack on attempt N is dropped server-side on attempt N+1.
// expiredAt is carried in the job payload so retries publish byte-identical events.
const EXPIRATION_JOB_ATTEMPTS = 5;
const EXPIRATION_JOB_BACKOFF_MS = 200;

export type ExpireOrderPayload = { orderId: string; expiredAt: string };

export type ExpirationServiceArgs = {
  db: DbClient<typeof expirationTables>;
  nats: NatsConnection;
  stream: string;
  redis: ConnectionOptions;
  logger?: Logger;
  ackWaitMs?: number;
  publisher?: Publisher;
};

export type RunningExpirationService = {
  scheduler: DelayedScheduler<ExpireOrderPayload>;
  worker: Worker<ExpireOrderPayload, void>;
  stop: () => Promise<void>;
};

export async function startExpirationService(
  args: ExpirationServiceArgs,
): Promise<RunningExpirationService> {
  const { db, nats, stream, redis, logger, ackWaitMs } = args;

  const loggerOpt = logger === undefined ? {} : { logger };
  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  const publisher = args.publisher ?? createPublisher(nats, { ...loggerOpt });

  const scheduler = createScheduler<ExpireOrderPayload>(redis, {
    queueName: EXPIRATION_QUEUE,
    ...loggerOpt,
    defaultJobOptions: {
      attempts: EXPIRATION_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: EXPIRATION_JOB_BACKOFF_MS },
    },
  });

  const worker = createWorker<ExpireOrderPayload>(redis, {
    queueName: EXPIRATION_QUEUE,
    handler: async ({ orderId, expiredAt }) => {
      const msgId = `expired:${orderId}`;
      const { ack } = await publisher.publish(ORDER_EXPIRED_V1, { orderId, expiredAt }, { msgId });
      logger?.info({ orderId, msgId, duplicate: ack.duplicate }, "order.expired.v1 published");
    },
    ...loggerOpt,
  });

  const consumer: RunningConsumer = await createConsumer(nats, {
    stream,
    subjectFilter: ORDER_CREATED_V1,
    group: EXPIRATION_CONSUMER_GROUP,
    schema: orderCreatedV1,
    ...loggerOpt,
    ...ackWaitOpt,
    handler: async ({ eventId, subject, payload }) => {
      await db.db.transaction(async (tx) => {
        const result = await withInboxDedupe(
          tx,
          expirationInbox,
          { eventId, subject },
          async () => {
            const delayMs = Math.max(0, new Date(payload.expiresAt).getTime() - Date.now());
            await scheduler.scheduleDelayed(
              EXPIRATION_JOB_NAME,
              { orderId: payload.orderId, expiredAt: payload.expiresAt },
              delayMs,
              payload.orderId,
            );
          },
        );

        if (result.deduped) {
          logger?.info(
            { eventId, orderId: payload.orderId },
            "skipping duplicate order.created.v1",
          );
        }
      });
    },
  });

  return {
    scheduler,
    worker,
    stop: async () => {
      await consumer.stop();
      await worker.close();
      await scheduler.close();
    },
  };
}
