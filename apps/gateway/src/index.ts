import { serve } from "@hono/node-server";
import { Cause, Effect, Exit, Fiber } from "effect";

import { createGatewayApp } from "./gateway-app.ts";
import { parseEnv } from "./gateway-env.ts";
import { makeGatewayRuntime } from "./gateway-runtime.ts";

const env = parseEnv(process.env);
const runtime = makeGatewayRuntime(env);
const app = createGatewayApp({
  runtime,
  webOrigin: env.webOrigin,
  authBaseUrl: env.authBaseUrl,
  faroCollectorUrl: env.faroCollectorUrl,
});

// The boot program acquires the HTTP server as a scoped resource, then parks on
// `Effect.never`. Interrupting the fiber runs the Scope finalizer (server close);
// disposing the runtime then flushes the OTLP exporters. This replaces the
// hand-rolled imperative construction and shutdown.
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

  yield* Effect.logInfo("gateway service listening").pipe(Effect.annotateLogs({ port: env.port }));

  yield* Effect.never;
});

// `Effect.scoped` ties the acquired server to this fiber's lifetime: parking on
// `Effect.never` keeps it open, and interrupting the fiber closes the scope.
const fiber = runtime.runFork(Effect.scoped(program));

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  // Boot/shutdown runs outside the Effect runtime's lifecycle (it is being torn down here),
  // so these last-resort diagnostics go to `console` rather than the Effect Logger.
  console.info("shutting down gateway service", { signal });

  void Effect.runPromise(Fiber.interrupt(fiber))
    .then(() => runtime.dispose())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error("error during gateway shutdown", { err });
      process.exit(1);
    });
}

// A failure before shutdown tears the runtime down and exits non-zero, mirroring the
// old `main().catch`.
fiber.addObserver((exit) => {
  if (shuttingDown || Exit.isSuccess(exit)) return;

  console.error("gateway service failed", { cause: Cause.pretty(exit.cause) });
  void runtime.dispose().finally(() => process.exit(1));
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
