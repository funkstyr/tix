import type { Context as OtelContext } from "@opentelemetry/api";
import { os } from "@orpc/server";
import { Effect } from "effect";

import { paymentCreateInput, paymentCreateOutput } from "@tix/contracts/payments";
import { externalParent } from "@tix/observability/otel-trace";

import type { PaymentsRuntime } from "../runtime/runtime.ts";
import { makeRunHandler } from "./boundary.ts";
import { createPaymentProgram } from "./create-payment.ts";

// Threaded from the Hono boundary (app.ts): the inbound request's trace context, so the
// handler's span continues the caller's trace.
export type PaymentsRequestContext = { otelParent: OtelContext };

// One span per oRPC request, parented onto the inbound trace context when present
// (otherwise a fresh root). Internal Stripe/db spans hang off this one, and the active
// span here is what `enqueueEvent` (inside recordPayment) captures for propagation.
function withRequestSpan<A, E, R>(
  op: string,
  context: PaymentsRequestContext,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return program.pipe(
    Effect.withSpan(`payments.rpc.${op}`, { parent: externalParent(context.otelParent) }),
  );
}

export function createPaymentsRouter(runtime: PaymentsRuntime) {
  const run = makeRunHandler(runtime);

  const base = os.$context<PaymentsRequestContext>();

  const create = base
    .input(paymentCreateInput)
    .output(paymentCreateOutput)
    .handler(({ input, context }) =>
      run(withRequestSpan("create", context, createPaymentProgram(input))),
    );

  return { create };
}

export type PaymentsRouter = ReturnType<typeof createPaymentsRouter>;
