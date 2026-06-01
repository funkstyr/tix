import { ORPCError } from "@orpc/server";
import { Cause, Effect, Exit, type ManagedRuntime, Match, Option } from "effect";

import type { PaymentError } from "../domain/errors.ts";

// The single oRPC seam translator (ADR-0008). Each domain tag maps to the exact
// `ORPCError` code / status / message / data the payments endpoint returns today,
// so the wire behavior is unchanged. `Match.tag` dispatches on the tagged-error
// `_tag`; `Match.exhaustive` makes a new `PaymentError` member fail the build until
// it has a handler here.
export function toORPCError(error: PaymentError): ORPCError<string, unknown> {
  return Match.value(error).pipe(
    Match.tag("OrderNotFound", () => new ORPCError("NOT_FOUND", { message: "order not found" })),

    Match.tag(
      "OrderForbidden",
      () => new ORPCError("FORBIDDEN", { message: "order belongs to another user" }),
    ),

    Match.tag(
      "OrderNotPayable",
      (e) =>
        new ORPCError("CONFLICT", {
          status: 409,
          message: "order is not payable",
          data: { reason: "not_payable" as const, status: e.status },
        }),
    ),

    Match.tag(
      "PaymentIntentNotSucceeded",
      (e) =>
        new ORPCError("UNPROCESSABLE_CONTENT", {
          status: 422,
          message: "payment intent did not succeed",
          data: { reason: "intent_not_succeeded" as const, status: e.status },
        }),
    ),

    Match.exhaustive,
  );
}

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

// Runs an oRPC handler's Effect program on the service runtime and reproduces the
// imperative throw-at-the-boundary contract: a domain failure becomes its mapped
// `ORPCError`, while an `ORPCError` raised inside the program (auth `UNAUTHORIZED`,
// a recordPayment `INTERNAL_SERVER_ERROR`) passes through untouched. A defect
// surfaces as the squashed cause, which oRPC turns into a 500 exactly as an uncaught
// throw does today.
export function makeRunHandler<R>(runtime: ManagedRuntime.ManagedRuntime<R, never>) {
  return async function runHandler<A>(
    program: Effect.Effect<A, PaymentError | ORPCError<string, unknown>, R>,
  ): Promise<A> {
    const exit = await runtime.runPromiseExit(program);
    if (Exit.isSuccess(exit)) return exit.value;

    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) {
      const error = failure.value;
      throw error instanceof ORPCError ? error : toORPCError(error);
    }

    throw Cause.squash(exit.cause);
  };
}
