import type { PaymentIntentStatus } from "@tix/contracts/payments";

// Low-cardinality failure taxonomy for the `reason` label on payments_failed_total.
// Buyer-side (card_declined) is expected and dashboard-only; the rest are our-side and
// page-worthy (see the stripe_alerts split). Kept a closed string union so the label can
// never explode — decline codes are NOT interpolated as labels.
export type StripeFailureReason =
  | "card_declined"
  | "rate_limited"
  | "api_error"
  | "authentication_error"
  | "idempotency_error"
  | "network"
  | "unknown";

// Stripe SDK errors carry a string `type` discriminator. Classifying on that string avoids
// `instanceof Stripe.errors.*` checks, which break when the SDK reorganizes its class tree.
const BY_TYPE: Record<string, StripeFailureReason> = {
  StripeCardError: "card_declined",
  StripeInvalidRequestError: "api_error",
  StripeRateLimitError: "rate_limited",
  StripeAPIError: "api_error",
  StripeAuthenticationError: "authentication_error",
  StripeIdempotencyError: "idempotency_error",
  StripeConnectionError: "network",
  // StripePermissionError (wrong API key scope) and StripeSignatureVerificationError
  // (webhook-only, never thrown on the charge path) deliberately fall through to "unknown".
};

export function classifyStripeError(error: unknown): StripeFailureReason {
  if (typeof error === "object" && error !== null && "type" in error) {
    const type = (error as { type: unknown }).type;
    if (typeof type === "string") {
      const reason = BY_TYPE[type];
      if (reason !== undefined) return reason;
    }
  }

  return "unknown";
}

// A confirmed PaymentIntent that comes back `requires_payment_method` means the card was
// declined at confirm time; every other non-succeeded status is out of PRD scope, so it
// buckets to `unknown` rather than inventing a reason.
export function statusToReason(status: PaymentIntentStatus): StripeFailureReason {
  return status === "requires_payment_method" ? "card_declined" : "unknown";
}
