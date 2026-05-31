import { ORPCError } from "@orpc/server";
import { Cause, Effect, Exit, type ManagedRuntime, Option } from "effect";

// Runs a promise that may throw an `ORPCError` and lifts it into the typed `E`
// channel. An `ORPCError` becomes a recoverable failure (the boundary rethrows it
// unchanged); anything else becomes a defect, so an unexpected throw still surfaces
// as a 500 exactly as it does today.
export function tryOrpc<A>(thunk: () => Promise<A>): Effect.Effect<A, ORPCError<string, unknown>> {
  return Effect.tryPromise({ try: thunk, catch: (e) => e }).pipe(
    Effect.catchAll((error) =>
      error instanceof ORPCError ? Effect.fail(error) : Effect.die(error),
    ),
  );
}

// Runs an oRPC handler's Effect program on the gateway runtime and reproduces the
// imperative throw-at-the-boundary contract: an `ORPCError` raised inside the program
// (a downstream service's error) passes through untouched — the gateway forwards
// downstream errors verbatim, so there's no domain-tag translation here. A defect
// surfaces as the squashed cause, which oRPC turns into a 500.
export function makeRunHandler<R>(runtime: ManagedRuntime.ManagedRuntime<R, never>) {
  return async function runHandler<A>(
    program: Effect.Effect<A, ORPCError<string, unknown>, R>,
  ): Promise<A> {
    const exit = await runtime.runPromiseExit(program);
    if (Exit.isSuccess(exit)) return exit.value;

    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) {
      throw failure.value;
    }

    throw Cause.squash(exit.cause);
  };
}
