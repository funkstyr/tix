import { ORPCError } from "@orpc/server";
import { Cause, Effect, Exit, type ManagedRuntime, Option } from "effect";

// Runs a promise that may throw an `ORPCError` and lifts it into the typed `E`
// channel. An `ORPCError` becomes a recoverable failure (the boundary rethrows it
// unchanged, or a caller maps it to a domain tag with `Effect.catchAll`); anything
// else becomes a defect, so an unexpected throw still surfaces as a 500 exactly as
// an uncaught throw does.
export function tryOrpc<A>(thunk: () => Promise<A>): Effect.Effect<A, ORPCError<string, unknown>> {
  return Effect.tryPromise({ try: thunk, catch: (e) => e }).pipe(
    Effect.catchAll((error) =>
      error instanceof ORPCError ? Effect.fail(error) : Effect.die(error),
    ),
  );
}

// Runs an oRPC handler's Effect program on the service runtime and reproduces the
// imperative throw-at-the-boundary contract (ADR-0008): a domain failure becomes its
// mapped `ORPCError` via the service's translator, while an `ORPCError` raised inside
// the program passes through untouched. A defect surfaces as the squashed cause, which
// oRPC turns into a 500.
export function makeRunHandler<R, E extends { readonly _tag: string }>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  toError: (error: E) => ORPCError<string, unknown>,
) {
  return async function runHandler<A>(
    program: Effect.Effect<A, E | ORPCError<string, unknown>, R>,
  ): Promise<A> {
    const exit = await runtime.runPromiseExit(program);
    if (Exit.isSuccess(exit)) return exit.value;

    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) {
      const error = failure.value;
      throw error instanceof ORPCError ? error : toError(error);
    }

    throw Cause.squash(exit.cause);
  };
}
