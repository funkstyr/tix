import { ORPCError } from "@orpc/server";
import { type ManagedRuntime, Match } from "effect";

import {
  makeRunHandler as makeGenericRunHandler,
  tryOrpc,
} from "@tix/service-runtime/orpc-boundary";

import type { TicketError } from "../domain/errors.ts";

// The generic exit-handling (lift, translate, rethrow, squash) lives in
// @tix/service-runtime/orpc-boundary; re-exported here so handler modules keep
// one import site for the wire seam.
export { tryOrpc };

// The single oRPC seam translator (ADR-0008). Each domain tag maps to the exact `ORPCError`
// code / status / message / data the tickets endpoints return today, so the wire behavior
// (and the assertions in `@tix/api-e2e` and the integration tests) is unchanged. `Match.tag`
// dispatches on the tagged-error `_tag`; `Match.exhaustive` makes a new `TicketError` member
// fail the build until it has a handler here.
export function toORPCError(error: TicketError): ORPCError<string, unknown> {
  return Match.value(error).pipe(
    Match.tag("TicketNotFound", () => new ORPCError("NOT_FOUND", { message: "ticket not found" })),

    Match.tag(
      "SoldOut",
      () =>
        new ORPCError("CONFLICT", {
          message: "ticket is sold out",
          data: { reason: "sold_out" as const },
        }),
    ),

    Match.tag(
      "ReservationConflict",
      () =>
        new ORPCError("CONFLICT", {
          message: "reservation conflict after retry",
          data: { reason: "version_conflict" as const },
        }),
    ),

    Match.tag(
      "TicketReserved",
      () =>
        new ORPCError("CONFLICT", {
          message: "cannot edit a reserved ticket",
          data: { reason: "reserved" as const },
        }),
    ),

    Match.tag(
      "TicketStale",
      () =>
        new ORPCError("CONFLICT", {
          message: "ticket was modified by someone else",
          data: { reason: "version_conflict" as const },
        }),
    ),

    Match.exhaustive,
  );
}

export function makeRunHandler<R>(runtime: ManagedRuntime.ManagedRuntime<R, never>) {
  return makeGenericRunHandler<R, TicketError>(runtime, toORPCError);
}
