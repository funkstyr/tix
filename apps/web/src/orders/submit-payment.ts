import type { Stripe, StripeElements } from "@stripe/stripe-js";

import type { GatewayRouterClient } from "@tix/contracts/gateway";
import type { PaymentIntentStatus } from "@tix/contracts/payments";

import { extractErrorMessage } from "../errors/extract-error-message";

export type SubmitPaymentArgs = {
  stripe: Stripe;
  elements: StripeElements;
  client: GatewayRouterClient;
  token: string;
  orderId: string;
};

export type SubmitPaymentResult = { kind: "ok" } | { kind: "error"; message: string };

// Three-stage submit so each failure surfaces as an inline error instead of
// throwing: Elements validates the form, Stripe.js tokenizes the card into a
// paymentMethodId that the gateway never sees the raw card for, then the
// gateway confirms the PaymentIntent server-side.
export async function submitPayment(args: SubmitPaymentArgs): Promise<SubmitPaymentResult> {
  const { stripe, elements, client, token, orderId } = args;

  const submitResult = await elements.submit();
  if (submitResult.error) {
    return {
      kind: "error",
      message: submitResult.error.message ?? "Payment details are incomplete",
    };
  }

  const methodResult = await stripe.createPaymentMethod({ elements });
  if (methodResult.error) {
    return { kind: "error", message: methodResult.error.message ?? "Could not tokenize card" };
  }

  let payment;
  try {
    payment = await client.payments.create({
      token,
      orderId,
      paymentMethodId: methodResult.paymentMethod.id,
    });
  } catch (err) {
    return { kind: "error", message: extractErrorMessage(err, "Payment failed") };
  }

  // The gateway confirms server-side, so non-throwing responses still need a
  // status check — `requires_action` (3DS) and `requires_payment_method`
  // (post-confirm decline) would otherwise navigate as if the charge worked.
  if (payment.status !== "succeeded") {
    return { kind: "error", message: paymentStatusMessage(payment.status) };
  }

  return { kind: "ok" };
}

function paymentStatusMessage(status: PaymentIntentStatus): string {
  if (status === "requires_action") {
    return "Card requires additional verification — please try a different card";
  }
  if (status === "processing")
    return "Payment is still processing — refresh to see the final status";

  return "Payment failed — please try a different card";
}
