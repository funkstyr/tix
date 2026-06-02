import { serve } from "@hono/node-server";
import { Cause, Effect, Exit, Fiber } from "effect";

import { startExpirationConsumer } from "./consumers/order-created.consumer.ts";
import { startExpireOrderWorker } from "./expire/expire-order.worker.ts";
import { createExpirationHealthApp } from "./health-app.ts";
import { parseEnv } from "./runtime/config.ts";
import { makeExpirationRuntime } from "./runtime/runtime.ts";
import { expirationSaturationPoller } from "./runtime/saturation.ts";
import { Nats } from "./runtime/services.ts";

const env = parseEnv();
const runtime = makeExpirationRuntime(env);

// The boot program acquires the worker and the order.created consumer as scoped resources,
// then parks on `Effect.never`. Interrupting the fiber runs the Scope finalizers LIFO
// (server → consumer → worker drain); disposing the runtime then closes the scheduler
// queue, the NATS connection, and the db pool. This replaces the hand-rolled imperative
// construction and reverse-order shutdown. Though headless (a BullMQ delayed-job worker),
// it serves a minimal health surface (ADR-0011 Tier 1) so Kubernetes can probe it.
const program = Effect.gen(function* () {
  const nats = yield* Nats;

  yield* Effect.acquireRelease(
    Effect.sync(() => startExpireOrderWorker({ runtime, redis: env.redis })),
    (worker) => Effect.promise(() => worker.close()),
  );

  yield* Effect.acquireRelease(
    Effect.promise(() => startExpirationConsumer({ runtime, nats, stream: env.stream })),
    (consumer) => Effect.promise(() => consumer.stop()),
  );

  const app = createExpirationHealthApp(runtime);

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

  // Tier 1 saturation poller (ADR-0011): forked into the boot scope so it is interrupted
  // alongside the worker/consumer/server when the fiber is torn down.
  yield* Effect.forkScoped(expirationSaturationPoller);

  yield* Effect.logInfo("expiration health listening").pipe(
    Effect.annotateLogs({ port: env.port }),
  );

  yield* Effect.logInfo("expiration service started").pipe(
    Effect.annotateLogs({ stream: env.stream, queue: "expiration" }),
  );

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

  // Boot/shutdown runs outside the Effect runtime's lifecycle (it is being torn down here),
  // so these last-resort diagnostics go to `console` rather than the Effect Logger.
  console.info("shutting down expiration service", { signal });

  void Effect.runPromise(Fiber.interrupt(fiber))
    .then(() => runtime.dispose())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error("error during expiration shutdown", { err });
      process.exit(1);
    });
}

// A failure before shutdown (e.g. NATS unreachable at boot) tears the runtime down and
// exits non-zero, mirroring the old `main().catch`.
fiber.addObserver((exit) => {
  if (shuttingDown || Exit.isSuccess(exit)) return;

  console.error("expiration service failed", { cause: Cause.pretty(exit.cause) });
  void runtime.dispose().finally(() => process.exit(1));
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
