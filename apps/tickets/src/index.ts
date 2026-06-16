import { Effect } from "effect";

import { outboxRelay } from "@tix/db-core/outbox";
import { acquireStoppable, runService } from "@tix/service-runtime/bootstrap";

import { startTicketsReleasedConsumer } from "./consumers/released.consumer.ts";
import { ticketsOutbox } from "./domain/schema.ts";
import { createTicketsApp } from "./http/app.ts";
import { parseEnv } from "./runtime/config.ts";
import { makeTicketsRuntime } from "./runtime/runtime.ts";
import { ticketsSaturationPoller } from "./runtime/saturation.ts";
import { Database, EventPublisher, Nats } from "./runtime/services.ts";

const env = parseEnv();
const runtime = makeTicketsRuntime(env);

runService({
  serviceName: "tickets",
  runtime,
  port: env.port,
  app: createTicketsApp(runtime),
  resources: Effect.gen(function* () {
    const db = yield* Database;
    const publisher = yield* EventPublisher;
    const nats = yield* Nats;

    yield* Effect.forkScoped(outboxRelay(db.db, ticketsOutbox, publisher.publish));
    yield* Effect.forkScoped(ticketsSaturationPoller);

    yield* acquireStoppable(() =>
      startTicketsReleasedConsumer({ runtime, nats, stream: env.ordersStream }),
    );
  }),
});
