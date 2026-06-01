import { Context, Effect, Layer } from "effect";

import { type DbClient } from "@tix/db-core/client";
import { createScheduler, type DelayedScheduler } from "@tix/messaging/jobs";

import { expirationTables } from "../expiration-schema.ts";
import {
  EXPIRATION_JOB_ATTEMPTS,
  EXPIRATION_JOB_BACKOFF_MS,
  EXPIRATION_QUEUE,
  type ExpireOrderPayload,
} from "../expire-order-job.ts";
import type { ExpirationEnv } from "./config.ts";

export { EventPublisher, Nats } from "@tix/service-runtime/tags";

export type ExpirationDb = DbClient<typeof expirationTables>;

export class ExpirationConfig extends Context.Tag("expiration/ExpirationConfig")<
  ExpirationConfig,
  ExpirationEnv
>() {}

export class Database extends Context.Tag("expiration/Database")<Database, ExpirationDb>() {}

export class Scheduler extends Context.Tag("expiration/Scheduler")<
  Scheduler,
  DelayedScheduler<ExpireOrderPayload>
>() {}

export function makeExpirationConfigLayer(env: ExpirationEnv): Layer.Layer<ExpirationConfig> {
  return Layer.succeed(ExpirationConfig, env);
}

// The BullMQ Queue that enqueues delayed expire-order jobs. Scoped so the queue's Redis
// connection is closed on shutdown. Stays a per-service domain layer.
export const SchedulerLayer: Layer.Layer<Scheduler, never, ExpirationConfig> = Layer.scoped(
  Scheduler,
  Effect.gen(function* () {
    const env = yield* ExpirationConfig;

    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        createScheduler<ExpireOrderPayload>(env.redis, {
          queueName: EXPIRATION_QUEUE,
          defaultJobOptions: {
            attempts: EXPIRATION_JOB_ATTEMPTS,
            backoff: { type: "exponential", delay: EXPIRATION_JOB_BACKOFF_MS },
          },
        }),
      ),
      (scheduler) => Effect.promise(() => scheduler.close()),
    );
  }),
);
