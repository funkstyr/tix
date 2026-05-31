import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Context, Effect, Layer } from "effect";

import { createDbClient, type DbClient } from "@tix/db-core/client";
import { createPublisher, type Publisher } from "@tix/messaging/jetstream";
import { createScheduler, type DelayedScheduler } from "@tix/messaging/jobs";

import { expirationTables } from "../expiration-schema.ts";
import {
  EXPIRATION_JOB_ATTEMPTS,
  EXPIRATION_JOB_BACKOFF_MS,
  EXPIRATION_QUEUE,
  type ExpireOrderPayload,
} from "../expire-order-job.ts";
import type { ExpirationEnv } from "./config.ts";

export type ExpirationDb = DbClient<typeof expirationTables>;

// Service tags. Together these replace the hand-injected `args` object — the
// consumer and worker resolve them from the runtime's Layer graph instead of
// receiving them as constructor arguments (ADR-0008).
export class ExpirationConfig extends Context.Tag("expiration/ExpirationConfig")<
  ExpirationConfig,
  ExpirationEnv
>() {}

export class Database extends Context.Tag("expiration/Database")<Database, ExpirationDb>() {}

export class Nats extends Context.Tag("expiration/Nats")<Nats, NatsConnection>() {}

export class EventPublisher extends Context.Tag("expiration/EventPublisher")<
  EventPublisher,
  Publisher
>() {}

export class Scheduler extends Context.Tag("expiration/Scheduler")<
  Scheduler,
  DelayedScheduler<ExpireOrderPayload>
>() {}

export function makeExpirationConfigLayer(env: ExpirationEnv): Layer.Layer<ExpirationConfig> {
  return Layer.succeed(ExpirationConfig, env);
}

// The db client connects lazily, so acquisition is synchronous; release drains
// the pool. Scope finalization tears it down automatically (LIFO) at shutdown.
export const DatabaseLayer: Layer.Layer<Database, never, ExpirationConfig> = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const env = yield* ExpirationConfig;

    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        createDbClient("expiration", env.databaseUrl, { schema: expirationTables }),
      ),
      (client) => Effect.promise(() => client.close()),
    );
  }),
);

export const NatsLayer: Layer.Layer<Nats, never, ExpirationConfig> = Layer.scoped(
  Nats,
  Effect.gen(function* () {
    const env = yield* ExpirationConfig;

    return yield* Effect.acquireRelease(
      Effect.promise(() => connect({ servers: env.natsUrl })),
      (nats) => Effect.promise(() => nats.close()),
    );
  }),
);

// The publisher's wire-level logging falls back to the messaging package's internal
// logger; expiration threads no pino logger (ADR-0009). Trace context for the
// published `order.expired.v1` rides on the BullMQ job, not on this layer.
export const EventPublisherLayer: Layer.Layer<EventPublisher, never, Nats> = Layer.effect(
  EventPublisher,
  Effect.map(Nats, (nats) => createPublisher(nats)),
);

// The BullMQ Queue that enqueues delayed expire-order jobs. Scoped so the queue's
// Redis connection is closed on shutdown (LIFO with the worker, which the boot
// program acquires separately). Job retry/backoff defaults make the at-least-once
// publish path work (see expire-order-job.ts).
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
