import { serve } from "@hono/node-server";
import { Cause, Effect, Exit, Fiber } from "effect";

import { startOutboxRelay } from "@tix/db-core/outbox";
import { createLogger } from "@tix/observability/logger";

import { startTicketsReleasedConsumer } from "./consumers/released.consumer.ts";
import { ticketsOutbox } from "./domain/schema.ts";
import { createTicketsApp } from "./http/app.ts";
import { parseEnv } from "./runtime/config.ts";
import { makeTicketsRuntime } from "./runtime/runtime.ts";
import { Database, EventPublisher, Nats } from "./runtime/services.ts";

// Last-resort logger for boot/shutdown failures outside the runtime's lifecycle.
const fallbackLogger = createLogger({ name: "tickets" });

const env = parseEnv();
const runtime = makeTicketsRuntime(env);

// The boot program acquires the relay, the release consumer, and the HTTP server as scoped
// resources, then parks on `Effect.never`. Interrupting the fiber runs the Scope finalizers
// LIFO (server → consumer → relay); disposing the runtime then closes the NATS connection
// and the db pool. This replaces the hand-rolled imperative construction and reverse-order
// shutdown.
const program = Effect.gen(function* () {
  const db = yield* Database;
  const publisher = yield* EventPublisher;
  const nats = yield* Nats;

  yield* Effect.acquireRelease(
    Effect.sync(() => startOutboxRelay(db.db, ticketsOutbox, publisher.publish)),
    (relay) => Effect.promise(() => relay.stop()),
  );

  yield* Effect.acquireRelease(
    Effect.promise(() => startTicketsReleasedConsumer({ runtime, nats, stream: env.ordersStream })),
    (consumer) => Effect.promise(() => consumer.stop()),
  );

  const app = createTicketsApp(runtime);

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

  yield* Effect.logInfo("tickets service listening").pipe(Effect.annotateLogs({ port: env.port }));

  yield* Effect.never;
});

// `Effect.scoped` ties the acquired resources to this fiber's lifetime: parking on
// `Effect.never` keeps them open, and interrupting the fiber closes the scope, running the
// finalizers LIFO.
const fiber = runtime.runFork(Effect.scoped(program));

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  fallbackLogger.info({ signal }, "shutting down tickets service");

  void Effect.runPromise(Fiber.interrupt(fiber))
    .then(() => runtime.dispose())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      fallbackLogger.fatal({ err }, "error during tickets shutdown");
      process.exit(1);
    });
}

// A failure before shutdown (e.g. NATS unreachable at boot) tears the runtime down and exits
// non-zero, mirroring the old `main().catch`.
fiber.addObserver((exit) => {
  if (shuttingDown || Exit.isSuccess(exit)) return;

  fallbackLogger.fatal({ cause: Cause.pretty(exit.cause) }, "tickets service failed");
  void runtime.dispose().finally(() => process.exit(1));
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
