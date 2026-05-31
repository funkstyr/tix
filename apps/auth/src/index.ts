import { serve } from "@hono/node-server";
import { Cause, Effect, Exit, Fiber } from "effect";

import { createLogger } from "@tix/observability/logger";

import { createAuthApp } from "./auth-app.ts";
import { parseEnv } from "./auth-env.ts";
import { makeAuthRuntime } from "./auth-runtime.ts";

// Last-resort logger for boot/shutdown failures outside the runtime's lifecycle.
const fallbackLogger = createLogger({ name: "auth" });

const env = parseEnv(process.env);
const runtime = makeAuthRuntime(env);
const app = createAuthApp({ runtime });

// The boot program acquires the HTTP server as a scoped resource, then parks on
// `Effect.never`. Interrupting the fiber runs the Scope finalizer (server close);
// disposing the runtime then drains the db pool and flushes the OTLP exporters. This
// replaces the hand-rolled imperative construction and shutdown.
const program = Effect.gen(function* () {
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

  yield* Effect.logInfo("auth service listening").pipe(Effect.annotateLogs({ port: env.port }));

  yield* Effect.never;
});

// `Effect.scoped` ties the acquired server to this fiber's lifetime: parking on
// `Effect.never` keeps it open, and interrupting the fiber closes the scope.
const fiber = runtime.runFork(Effect.scoped(program));

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  fallbackLogger.info({ signal }, "shutting down auth service");

  void Effect.runPromise(Fiber.interrupt(fiber))
    .then(() => runtime.dispose())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      fallbackLogger.fatal({ err }, "error during auth shutdown");
      process.exit(1);
    });
}

// A failure before shutdown tears the runtime down and exits non-zero, mirroring the old
// `main().catch`.
fiber.addObserver((exit) => {
  if (shuttingDown || Exit.isSuccess(exit)) return;

  fallbackLogger.fatal({ cause: Cause.pretty(exit.cause) }, "auth service failed");
  void runtime.dispose().finally(() => process.exit(1));
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
