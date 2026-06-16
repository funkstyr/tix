import { Effect } from "effect";

import { acquireStoppable, runService } from "@tix/service-runtime/bootstrap";

import { startExpirationConsumer } from "./consumers/order-created.consumer.ts";
import { startExpireOrderWorker } from "./expire/expire-order.worker.ts";
import { createExpirationHealthApp } from "./health-app.ts";
import { parseEnv } from "./runtime/config.ts";
import { makeExpirationRuntime } from "./runtime/runtime.ts";
import { expirationSaturationPoller } from "./runtime/saturation.ts";
import { Nats } from "./runtime/services.ts";

const env = parseEnv();
const runtime = makeExpirationRuntime(env);

// Though headless (a BullMQ delayed-job worker), expiration serves a minimal
// health surface (ADR-0011 Tier 1) so Kubernetes can probe it.
runService({
  serviceName: "expiration",
  runtime,
  port: env.port,
  app: createExpirationHealthApp(runtime),
  resources: Effect.gen(function* () {
    const nats = yield* Nats;

    yield* Effect.acquireRelease(
      Effect.sync(() => startExpireOrderWorker({ runtime, redis: env.redis })),
      (worker) => Effect.promise(() => worker.close()),
    );

    yield* acquireStoppable(() => startExpirationConsumer({ runtime, nats, stream: env.stream }));

    yield* Effect.forkScoped(expirationSaturationPoller);
  }),
});
