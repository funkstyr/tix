import type { NatsConnection } from "@nats-io/transport-node";
import { Layer } from "effect";

import { createPublisher, type Publisher } from "@tix/messaging/jetstream";
import { type DelayedScheduler } from "@tix/messaging/jobs";
import { EventPublisher, Nats } from "@tix/service-runtime/tags";
import { makeServiceTestRuntime, throwingNats, throwingPublisher } from "@tix/service-runtime/test";

import type { ExpireOrderPayload } from "../expire-order-job.ts";
import type { ExpirationEnv } from "./config.ts";
import type { ExpirationRuntime } from "./runtime.ts";
import { Database, ExpirationConfig, type ExpirationDb, Scheduler } from "./services.ts";

export type ExpirationTestDeps = {
  db: ExpirationDb;
  nats?: NatsConnection;
  scheduler?: DelayedScheduler<ExpireOrderPayload>;
  // Overrides the nats-backed publisher — e.g. to simulate a lost ack and force a
  // BullMQ retry that JetStream then dedupes.
  publisher?: Publisher;
};

// Builds a ManagedRuntime from explicit, already-constructed collaborators instead of the
// env-driven resource layers, so integration tests drive the same Effect programs the
// consumer and worker run in production. The caller owns the lifecycle of the `nats`
// connection and `scheduler` it passes in (closed in test teardown); OTLP is omitted —
// logs go through Effect's pretty logger. Any collaborator a given test omits gets a
// throwing stub so an accidental dependency surfaces loudly.
export function createExpirationTestRuntime(deps: ExpirationTestDeps): ExpirationRuntime {
  const base = Layer.mergeAll(
    Layer.succeed(ExpirationConfig, makeTestEnv()),
    Layer.succeed(Database, deps.db),
  );

  const nats = deps.nats;
  const natsLayer = Layer.succeed(Nats, nats ?? throwingNats());

  const publisher =
    deps.publisher ?? (nats === undefined ? throwingPublisher() : createPublisher(nats));
  const publisherLayer = Layer.succeed(EventPublisher, publisher);

  const schedulerLayer = Layer.succeed(Scheduler, deps.scheduler ?? throwingScheduler());

  return makeServiceTestRuntime(Layer.mergeAll(base, natsLayer, publisherLayer, schedulerLayer));
}

function makeTestEnv(): ExpirationEnv {
  return {
    databaseUrl: "postgres://test",
    natsUrl: "nats://test",
    redis: { host: "localhost", port: 6379 },
    stream: "ORDERS",
    otelEndpoint: "http://otel.test:4318",
  };
}

function throwingScheduler(): DelayedScheduler<ExpireOrderPayload> {
  return {
    scheduleDelayed: () => {
      throw new Error("Scheduler not provided to test runtime");
    },
    close: () => {
      throw new Error("Scheduler not provided to test runtime");
    },
  };
}
