import { Effect } from "effect";

import { outboxRelay } from "@tix/db-core/outbox";
import { acquireStoppable, runService } from "@tix/service-runtime/bootstrap";

import {
  startPaymentsOrderCancelledConsumer,
  startPaymentsOrderCreatedConsumer,
} from "./consumers/order-projection.consumer.ts";
import { paymentsOutbox } from "./domain/schema.ts";
import { createPaymentsApp } from "./http/app.ts";
import { parseEnv } from "./runtime/config.ts";
import { makePaymentsRuntime } from "./runtime/runtime.ts";
import { paymentsSaturationPoller } from "./runtime/saturation.ts";
import { Database, EventPublisher, Nats } from "./runtime/services.ts";

const env = parseEnv();
const runtime = makePaymentsRuntime(env);

runService({
  serviceName: "payments",
  runtime,
  port: env.port,
  app: createPaymentsApp(runtime),
  resources: Effect.gen(function* () {
    const db = yield* Database;
    const publisher = yield* EventPublisher;
    const nats = yield* Nats;

    yield* Effect.forkScoped(outboxRelay(db.db, paymentsOutbox, publisher.publish));
    yield* Effect.forkScoped(paymentsSaturationPoller);

    // The order-projection consumers read `order.*` events, which live in the
    // ORDERS stream — not payments' own PAYMENTS stream. Binding them to
    // `env.stream` matches zero messages.
    yield* acquireStoppable(() =>
      startPaymentsOrderCreatedConsumer({ runtime, nats, stream: env.ordersStream }),
    );
    yield* acquireStoppable(() =>
      startPaymentsOrderCancelledConsumer({ runtime, nats, stream: env.ordersStream }),
    );
  }),
});
