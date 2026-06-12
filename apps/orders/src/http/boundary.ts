import { ORPCError } from "@orpc/server";
import { type ManagedRuntime, Match } from "effect";

import {
  makeRunHandler as makeGenericRunHandler,
  tryOrpc,
} from "@tix/service-runtime/orpc-boundary";

import type { OrderError } from "../domain/errors.ts";

// The generic exit-handling (lift, translate, rethrow, squash) lives in
// @tix/service-runtime/orpc-boundary; re-exported here so handler modules keep
// one import site for the wire seam.
export { tryOrpc };

// The single oRPC seam translator (ADR-0008). Each domain tag maps to the exact
// `ORPCError` code / status / message / data the orders endpoints return today,
// so the wire behavior is unchanged. `Match.tag` dispatches on the tagged-error
// `_tag`; `Match.exhaustive` makes a new `OrderError` member fail the build until
// it has a handler here.
export function toORPCError(error: OrderError): ORPCError<string, unknown> {
  return Match.value(error).pipe(
    Match.tag("TicketNotFound", () => new ORPCError("NOT_FOUND", { message: "ticket not found" })),

    Match.tag(
      "BuyerIsSeller",
      () => new ORPCError("FORBIDDEN", { message: "buyer cannot purchase their own ticket" }),
    ),

    Match.tag(
      "SoldOut",
      () =>
        new ORPCError("GONE", {
          status: 410,
          message: "ticket is sold out",
          data: { reason: "sold_out" as const },
        }),
    ),

    Match.tag(
      "ReservationConflict",
      () =>
        new ORPCError("CONFLICT", {
          status: 409,
          message: "reservation conflict",
          data: { reason: "race_lost" as const },
        }),
    ),

    Match.tag("OrderNotFound", () => new ORPCError("NOT_FOUND", { message: "order not found" })),

    Match.exhaustive,
  );
}

export function makeRunHandler<R>(runtime: ManagedRuntime.ManagedRuntime<R, never>) {
  return makeGenericRunHandler<R, OrderError>(runtime, toORPCError);
}
