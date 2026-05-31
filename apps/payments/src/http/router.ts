import type { Context as OtelContext } from "@opentelemetry/api";
import { os } from "@orpc/server";
import { eq } from "drizzle-orm";
import { Clock, Effect, Metric } from "effect";

import { requireSession } from "@tix/contracts/auth-client";
import { paymentCreateInput, paymentCreateOutput } from "@tix/contracts/payments";
import { externalParent } from "@tix/observability/otel-trace";

import {
  OrderForbidden,
  OrderNotFound,
  OrderNotPayable,
  PaymentIntentNotSucceeded,
} from "../domain/errors.ts";
import { orderReadModel } from "../domain/schema.ts";
import { recordPayment } from "../payment-repository.ts";
import {
  paymentChargeLatencyMs,
  paymentsFailedTotal,
  paymentsSucceededTotal,
} from "../runtime/metrics.ts";
import type { PaymentsRuntime } from "../runtime/runtime.ts";
import { AuthClient, Database, PaymentIntents } from "../runtime/services.ts";
import { makeRunHandler, tryOrpc } from "./boundary.ts";

const DEFAULT_CURRENCY = "usd";
const PAYABLE_ORDER_STATUS = "created";

// Threaded from the Hono boundary (app.ts): the inbound request's trace context, so the
// handler's span continues the caller's trace.
export type PaymentsRequestContext = { otelParent: OtelContext };

// Exported as a standalone program (against the service `R` channel) so tests can run it
// under an ambient `TestClock` — the router just wraps it with `run`, which executes it on
// the live runtime.
export function createPaymentProgram(input: typeof paymentCreateInput.infer) {
  return Effect.gen(function* () {
    const authClient = yield* AuthClient;
    const db = yield* Database;
    const paymentIntentClient = yield* PaymentIntents;

    const session = yield* tryOrpc(() => requireSession(authClient, input.token));

    const [order] = yield* tryOrpc(() =>
      db.db.select().from(orderReadModel).where(eq(orderReadModel.id, input.orderId)),
    );
    if (!order) {
      return yield* Effect.fail(new OrderNotFound({ orderId: input.orderId }));
    }

    if (order.userId !== session.user.id) {
      return yield* Effect.fail(new OrderForbidden({ orderId: input.orderId }));
    }

    if (order.status !== PAYABLE_ORDER_STATUS) {
      return yield* Effect.fail(
        new OrderNotPayable({ orderId: input.orderId, status: order.status }),
      );
    }

    // Stripe charge sits outside the DB tx on purpose: PaymentIntent has network latency we
    // don't want holding a row lock. Idempotency is a two-tier safety net: Stripe's
    // idempotency-key cache (keyed on orderId) dedupes the charge, and the UNIQUE(order_id)
    // constraint backing recordPayment's ON CONFLICT dedupes our writes. A retry that
    // follows a successful Stripe call but failed DB write recovers cleanly: same
    // PaymentIntent from Stripe, conflict-fallback SELECT returns the row.
    const startMs = yield* Clock.currentTimeMillis;
    const intent = yield* tryOrpc(() =>
      paymentIntentClient.createPaymentIntent({
        orderId: order.id,
        amountCents: order.priceCents,
        currency: DEFAULT_CURRENCY,
        paymentMethodId: input.paymentMethodId,
      }),
    ).pipe(Effect.withSpan("payments.stripe.create_payment_intent"));
    const endMs = yield* Clock.currentTimeMillis;

    yield* Metric.update(paymentChargeLatencyMs, endMs - startMs);

    // Only `succeeded` is money-in-the-bank — 3DS, processing, and requires-* are out of
    // PRD scope. Skipping the row keeps UNIQUE(order_id) open for a retry with a different
    // card and prevents `payment.created.v1` firing for a charge that didn't actually clear.
    if (intent.status !== "succeeded") {
      yield* Metric.increment(paymentsFailedTotal);

      return yield* Effect.fail(new PaymentIntentNotSucceeded({ status: intent.status }));
    }

    const recorded = yield* tryOrpc(() =>
      db.db.transaction((tx) =>
        recordPayment(tx, {
          orderId: order.id,
          userId: session.user.id,
          stripeId: intent.stripeId,
          amountCents: order.priceCents,
          currency: DEFAULT_CURRENCY,
          status: intent.status,
        }),
      ),
    ).pipe(Effect.withSpan("payments.db.record_payment"));

    yield* Metric.increment(paymentsSucceededTotal);

    return { id: recorded.id, status: recorded.status };
  });
}

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
