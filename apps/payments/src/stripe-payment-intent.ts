import type Stripe from "stripe";

import type { PaymentIntentStatus } from "@tix/contracts/payments";

export type CreatePaymentIntentArgs = {
  orderId: string;
  amountCents: number;
  currency: string;
  paymentMethodId: string;
};

export type PaymentIntentResult = {
  stripeId: string;
  status: PaymentIntentStatus;
};

export type PaymentIntentClient = {
  createPaymentIntent: (args: CreatePaymentIntentArgs) => Promise<PaymentIntentResult>;
};

export function createStripePaymentIntentClient(stripe: Stripe): PaymentIntentClient {
  return {
    createPaymentIntent: async (args) => {
      // orderId as the idempotency key: Stripe's 24h window outlasts any Order's
      // awaiting_payment lifetime, so a duplicate buyer click never doubles-charges.
      const intent = await stripe.paymentIntents.create(
        {
          amount: args.amountCents,
          currency: args.currency,
          payment_method: args.paymentMethodId,
          confirm: true,
          // Confirming server-side with no browser to handle redirects: opt out of
          // redirect-based methods so Stripe doesn't demand a `return_url`. Required since the
          // pinned SDK API version (2024-06+/dahlia) rejects a bare `confirm` + `payment_method`
          // with an invalid_request_error otherwise.
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          metadata: { orderId: args.orderId },
        },
        { idempotencyKey: args.orderId },
      );

      return { stripeId: intent.id, status: intent.status };
    },
  };
}
