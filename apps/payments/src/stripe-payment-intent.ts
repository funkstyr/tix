import type Stripe from "stripe";

export type CreatePaymentIntentArgs = {
  orderId: string;
  amountCents: number;
  currency: string;
  paymentMethodId: string;
};

export type PaymentIntentResult = {
  stripeId: string;
  status: string;
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
          metadata: { orderId: args.orderId },
        },
        { idempotencyKey: args.orderId },
      );

      return { stripeId: intent.id, status: intent.status };
    },
  };
}
