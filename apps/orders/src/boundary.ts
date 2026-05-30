import { ORPCError } from "@orpc/server";
import { Cause, Effect, Exit, type ManagedRuntime, Option } from "effect";

import type { OrderError } from "./errors.ts";

// The single oRPC seam translator (ADR-0008). Each domain tag maps to the exact
// `ORPCError` code / status / message / data the orders endpoints return today,
// so the wire behavior is unchanged.
export function toORPCError(error: OrderError): ORPCError<string, unknown> {
  switch (error._tag) {
    case "TicketNotFound":
      return new ORPCError("NOT_FOUND", { message: "ticket not found" });

    case "BuyerIsSeller":
      return new ORPCError("FORBIDDEN", { message: "buyer cannot purchase their own ticket" });

    case "SoldOut":
      return new ORPCError("GONE", {
        status: 410,
        message: "ticket is sold out",
        data: { reason: "sold_out" as const },
      });

    case "ReservationConflict":
      return new ORPCError("CONFLICT", {
        status: 409,
        message: "reservation conflict",
        data: { reason: "race_lost" as const },
      });

    case "OrderNotFound":
      return new ORPCError("NOT_FOUND", { message: "order not found" });
  }
}

// Runs an oRPC handler's Effect program on the service runtime and reproduces the
// imperative throw-at-the-boundary contract: a domain failure becomes its mapped
// `ORPCError`, while an `ORPCError` raised inside the program (auth `UNAUTHORIZED`,
// a tickets error we deliberately re-raise, an insert `INTERNAL_SERVER_ERROR`)
// passes through untouched. A defect surfaces as the squashed cause, which oRPC
// turns into a 500 exactly as an uncaught throw does today.
export function makeRunHandler<R>(runtime: ManagedRuntime.ManagedRuntime<R, never>) {
  return async function runHandler<A>(
    program: Effect.Effect<A, OrderError | ORPCError, R>,
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
