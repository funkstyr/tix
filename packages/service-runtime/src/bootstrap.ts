import { serve, type ServerType } from "@hono/node-server";
import { Cause, Effect, Exit, Fiber, type ManagedRuntime, type Scope } from "effect";
import type { Hono } from "hono";

// Acquires a started resource with a `stop()` finalizer (JetStream consumers,
// pollers) as a scoped resource; releasing the scope stops it.
export function acquireStoppable<T extends { stop: () => Promise<void> }>(
  start: () => Promise<T>,
): Effect.Effect<T, never, Scope.Scope> {
  return Effect.acquireRelease(Effect.promise(start), (resource) =>
    Effect.promise(() => resource.stop()),
  );
}

// Acquires the Hono node server as a scoped resource. Port 0 binds an ephemeral
// port (used by tests).
export function acquireHttpServer(
  app: Hono,
  port: number,
): Effect.Effect<ServerType, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.async<ServerType>((resume) => {
      const server = serve({ fetch: app.fetch, port }, () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.async<void>((resume) => {
        server.close((err) => resume(err ? Effect.die(err) : Effect.void));
      }),
  );
}

export type RunServiceOptions<R> = {
  serviceName: string;
  runtime: ManagedRuntime.ManagedRuntime<R, never>;
  port: number;
  app: Hono;
  // Service-specific scoped resources (outbox relay, saturation poller, consumers,
  // workers) acquired BEFORE the HTTP server and therefore released AFTER it (LIFO),
  // so in-flight requests drain before their dependencies are torn down.
  resources?: Effect.Effect<unknown, never, R | Scope.Scope>;
};

// The uniform boot/shutdown lifecycle (ADR-0008): the boot program acquires the
// service's resources and the HTTP server as scoped resources, then parks on
// `Effect.never`. Interrupting the fiber runs the Scope finalizers LIFO; disposing
// the runtime then closes the NATS connection and the db pool. SIGINT/SIGTERM
// interrupt the fiber; a boot failure (e.g. NATS unreachable) tears the runtime
// down and exits non-zero.
export function runService<R>(opts: RunServiceOptions<R>): void {
  const program = Effect.gen(function* () {
    if (opts.resources !== undefined) yield* opts.resources;

    yield* acquireHttpServer(opts.app, opts.port);

    yield* Effect.logInfo(`${opts.serviceName} service listening`).pipe(
      Effect.annotateLogs({ port: opts.port }),
    );

    yield* Effect.never;
  });

  const fiber = opts.runtime.runFork(Effect.scoped(program));

  let shuttingDown = false;

  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    // Boot/shutdown runs outside the Effect runtime's lifecycle (it is being torn
    // down here), so these last-resort diagnostics go to `console` rather than the
    // Effect Logger.
    console.info(`shutting down ${opts.serviceName} service`, { signal });

    void Effect.runPromise(Fiber.interrupt(fiber))
      .then(() => opts.runtime.dispose())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error(`error during ${opts.serviceName} shutdown`, { err });
        process.exit(1);
      });
  }

  fiber.addObserver((exit) => {
    if (shuttingDown || Exit.isSuccess(exit)) return;

    console.error(`${opts.serviceName} service failed`, { cause: Cause.pretty(exit.cause) });
    void opts.runtime.dispose().finally(() => process.exit(1));
  });

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
