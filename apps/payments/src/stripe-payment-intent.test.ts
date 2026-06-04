import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { createStripePaymentIntentClient } from "./stripe-payment-intent.ts";

// Capture the exact params handed to Stripe so we pin the request shape — the layer the real
// API rejects (a bare `confirm` + `payment_method`) lives below the PaymentIntentClient seam the
// other payments tests mock, so this is the only place that guards it.
function stubStripe(): { stripe: Stripe; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn<
    (params: unknown, options?: unknown) => Promise<{ id: string; status: string }>
  >(() => Promise.resolve({ id: "pi_test", status: "succeeded" }));
  const stripe = { paymentIntents: { create } } as unknown as Stripe;
  return { stripe, create };
}

describe("createStripePaymentIntentClient", () => {
  it("opts out of redirect-based methods so Stripe doesn't demand a return_url", async () => {
    const { stripe, create } = stubStripe();

    await createStripePaymentIntentClient(stripe).createPaymentIntent({
      orderId: "11111111-1111-4111-8111-111111111111",
      amountCents: 5000,
      currency: "usd",
      paymentMethodId: "pm_card_visa",
    });

    const [params] = create.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    });
  });

  it("uses the orderId as the Stripe idempotency key", async () => {
    const { stripe, create } = stubStripe();

    await createStripePaymentIntentClient(stripe).createPaymentIntent({
      orderId: "22222222-2222-4222-8222-222222222222",
      amountCents: 5000,
      currency: "usd",
      paymentMethodId: "pm_card_visa",
    });

    const options = create.mock.calls[0]?.[1];
    expect(options).toMatchObject({ idempotencyKey: "22222222-2222-4222-8222-222222222222" });
  });
});
