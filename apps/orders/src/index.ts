import { Effect } from "effect";

import { outboxRelay } from "@tix/db-core/outbox";
import { acquireStoppable, runService } from "@tix/service-runtime/bootstrap";

import { startOrdersExpiredConsumer } from "./consumers/order-expired.consumer.ts";
import { startOrdersPaymentCreatedConsumer } from "./consumers/payment-created.consumer.ts";
import {
  startTicketsCreatedConsumer,
  startTicketsUpdatedConsumer,
} from "./consumers/tickets-replica.consumer.ts";
import { ordersOutbox } from "./domain/schema.ts";
import { createOrdersApp } from "./http/app.ts";
import { parseEnv } from "./runtime/config.ts";
import { makeOrdersRuntime } from "./runtime/runtime.ts";
import { ordersSaturationPoller } from "./runtime/saturation.ts";
import { Database, EventPublisher, Nats } from "./runtime/services.ts";

const env = parseEnv();
const runtime = makeOrdersRuntime(env);

runService({
  serviceName: "orders",
  runtime,
  port: env.port,
  app: createOrdersApp(runtime),
  resources: Effect.gen(function* () {
    const db = yield* Database;
    const publisher = yield* EventPublisher;
    const nats = yield* Nats;

    yield* Effect.forkScoped(outboxRelay(db.db, ordersOutbox, publisher.publish));
    yield* Effect.forkScoped(ordersSaturationPoller);

    yield* acquireStoppable(() =>
      startOrdersExpiredConsumer({ runtime, nats, stream: env.stream }),
    );
    yield* acquireStoppable(() =>
      startOrdersPaymentCreatedConsumer({ runtime, nats, stream: env.paymentsStream }),
    );
    yield* acquireStoppable(() =>
      startTicketsCreatedConsumer({ runtime, nats, stream: env.ticketsStream }),
    );
    yield* acquireStoppable(() =>
      startTicketsUpdatedConsumer({ runtime, nats, stream: env.ticketsStream }),
    );
  }),
});
