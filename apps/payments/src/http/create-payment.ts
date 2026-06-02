import { eq } from "drizzle-orm";
import { Clock, Effect, Metric } from "effect";

import { requireSession } from "@tix/contracts/auth-client";
import { paymentCreateInput } from "@tix/contracts/payments";
import { SpanAttr } from "@tix/observability/attributes";
import { dbSpan } from "@tix/observability/db-span";
import { withResilience, withTimeout } from "@tix/observability/resilience";

import {
  OrderForbidden,
  OrderNotFound,
  OrderNotPayable,
  PaymentIntentNotSucceeded,
} from "../domain/errors.ts";
import { orderReadModel, type OrderReadModelStatus } from "../domain/schema.ts";
import { recordPayment } from "../payment-repository.ts";
import {
  paymentChargeLatencyMs,
  paymentsFailedTotal,
  paymentsSucceededTotal,
} from "../runtime/metrics.ts";
import { AuthClient, Database, PaymentIntents } from "../runtime/services.ts";
import { tryOrpc } from "./boundary.ts";

const DEFAULT_CURRENCY = "usd";
const PAYABLE_ORDER_STATUS: OrderReadModelStatus = "created";

// Exported as a standalone program (against the service `R` channel) so tests can run it
// under an ambient `TestClock` — the router just wraps it with `run`, which executes it on
// the live runtime.
export function createPaymentProgram(input: typeof paymentCreateInput.infer) {
  return Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan(SpanAttr.orderId, input.orderId);

    const authClient = yield* AuthClient;
    const db = yield* Database;
    const paymentIntentClient = yield* PaymentIntents;

    const session = yield* withResilience(
      "payments.auth.require_session",
      tryOrpc(() => requireSession(authClient, input.token)),
    );

    const [order] = yield* withResilience(
      "payments.db.select_order",
      tryOrpc(() =>
        db.db.select().from(orderReadModel).where(eq(orderReadModel.id, input.orderId)),
      ),
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
    const intent = yield* withResilience(
      "payments.stripe.create_payment_intent",
      tryOrpc(() =>
        paymentIntentClient.createPaymentIntent({
          orderId: order.id,
          amountCents: order.priceCents,
          currency: DEFAULT_CURRENCY,
          paymentMethodId: input.paymentMethodId,
        }),
      ),
    );
    const endMs = yield* Clock.currentTimeMillis;

    yield* Metric.update(paymentChargeLatencyMs, endMs - startMs);

    // Only `succeeded` is money-in-the-bank — 3DS, processing, and requires-* are out of
    // PRD scope. Skipping the row keeps UNIQUE(order_id) open for a retry with a different
    // card and prevents `payment.created.v1` firing for a charge that didn't actually clear.
    if (intent.status !== "succeeded") {
      yield* Metric.increment(paymentsFailedTotal);

      return yield* Effect.fail(new PaymentIntentNotSucceeded({ status: intent.status }));
    }

    const recorded = yield* dbSpan(
      "record_payment",
      "payments.payments",
      withTimeout(
        "payments.db.record_payment",
        tryOrpc(() =>
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
        ),
      ),
    );

    yield* Metric.increment(paymentsSucceededTotal);

    yield* Effect.annotateCurrentSpan(SpanAttr.paymentId, recorded.id);
    yield* Effect.annotateCurrentSpan(SpanAttr.valueCents, order.priceCents);

    return { id: recorded.id, status: recorded.status };
  });
}
