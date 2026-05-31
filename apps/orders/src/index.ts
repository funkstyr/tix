import { serve } from "@hono/node-server";
import { Cause, Effect, Exit, Fiber } from "effect";

import { startOutboxRelay } from "@tix/db-core/outbox";

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
import { Database, EventPublisher, Nats } from "./runtime/services.ts";

const env = parseEnv();
const runtime = makeOrdersRuntime(env);

// The boot program acquires the relay, the four consumers, and the HTTP server as
// scoped resources, then parks on `Effect.never`. Interrupting the fiber runs the
// Scope finalizers LIFO (server → consumers → relay); disposing the runtime then
// closes the NATS connection and the db pool. This replaces the hand-rolled
// imperative construction and reverse-order shutdown.
const program = Effect.gen(function* () {
  const db = yield* Database;
  const publisher = yield* EventPublisher;
  const nats = yield* Nats;

  yield* Effect.acquireRelease(
    Effect.sync(() => startOutboxRelay(db.db, ordersOutbox, publisher.publish)),
    (relay) => Effect.promise(() => relay.stop()),
  );

  yield* Effect.acquireRelease(
    Effect.promise(() => startOrdersExpiredConsumer({ runtime, nats, stream: env.stream })),
    (consumer) => Effect.promise(() => consumer.stop()),
  );

  yield* Effect.acquireRelease(
    Effect.promise(() =>
      startOrdersPaymentCreatedConsumer({ runtime, nats, stream: env.paymentsStream }),
    ),
    (consumer) => Effect.promise(() => consumer.stop()),
  );

  yield* Effect.acquireRelease(
    Effect.promise(() => startTicketsCreatedConsumer({ runtime, nats, stream: env.ticketsStream })),
    (consumer) => Effect.promise(() => consumer.stop()),
  );

  yield* Effect.acquireRelease(
    Effect.promise(() => startTicketsUpdatedConsumer({ runtime, nats, stream: env.ticketsStream })),
    (consumer) => Effect.promise(() => consumer.stop()),
  );

  const app = createOrdersApp(runtime);

  yield* Effect.acquireRelease(
    Effect.async<ReturnType<typeof serve>>((resume) => {
      const server = serve({ fetch: app.fetch, port: env.port }, () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.async<void>((resume) => {
        server.close((err) => resume(err ? Effect.die(err) : Effect.void));
      }),
  );

  yield* Effect.logInfo("orders service listening").pipe(Effect.annotateLogs({ port: env.port }));

  yield* Effect.never;
});

// `Effect.scoped` ties the acquired resources to this fiber's lifetime: parking
// on `Effect.never` keeps them open, and interrupting the fiber closes the scope,
// running the finalizers LIFO.
const fiber = runtime.runFork(Effect.scoped(program));

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  // Boot/shutdown runs outside the Effect runtime's lifecycle (it is being torn down here),
  // so these last-resort diagnostics go to `console` rather than the Effect Logger.
  console.info("shutting down orders service", { signal });

  void Effect.runPromise(Fiber.interrupt(fiber))
    .then(() => runtime.dispose())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error("error during orders shutdown", { err });
      process.exit(1);
    });
}

// A failure before shutdown (e.g. NATS unreachable at boot) tears the runtime down
// and exits non-zero, mirroring the old `main().catch`.
fiber.addObserver((exit) => {
  if (shuttingDown || Exit.isSuccess(exit)) return;

  console.error("orders service failed", { cause: Cause.pretty(exit.cause) });
  void runtime.dispose().finally(() => process.exit(1));
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
