import { ORPCError } from "@orpc/server";
import { type ManagedRuntime, Match } from "effect";

import {
  makeRunHandler as makeGenericRunHandler,
  tryOrpc,
} from "@tix/service-runtime/orpc-boundary";

import type { PaymentError } from "../domain/errors.ts";

// The generic exit-handling (lift, translate, rethrow, squash) lives in
// @tix/service-runtime/orpc-boundary; re-exported here so handler modules keep
// one import site for the wire seam.
export { tryOrpc };

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

export function makeRunHandler<R>(runtime: ManagedRuntime.ManagedRuntime<R, never>) {
  return makeGenericRunHandler<R, PaymentError>(runtime, toORPCError);
}
