import { describe, expect, it } from "vitest";

import { classifyStripeError, statusToReason } from "./stripe-error.ts";

// Stripe SDK errors expose a string `type` discriminator (e.g. "StripeCardError").
// We classify on that string so we don't need `instanceof` against the SDK's class
// hierarchy, which is brittle across SDK minor versions.
describe("classifyStripeError", () => {
  it("maps card errors to the buyer-side reason", () => {
    expect(classifyStripeError({ type: "StripeCardError" })).toBe("card_declined");
  });

  it("maps rate-limit errors", () => {
    expect(classifyStripeError({ type: "StripeRateLimitError" })).toBe("rate_limited");
  });

  it("maps generic API errors", () => {
    expect(classifyStripeError({ type: "StripeAPIError" })).toBe("api_error");
  });

  it("maps authentication errors", () => {
    expect(classifyStripeError({ type: "StripeAuthenticationError" })).toBe("authentication_error");
  });

  it("maps idempotency errors", () => {
    expect(classifyStripeError({ type: "StripeIdempotencyError" })).toBe("idempotency_error");
  });

  it("maps connection errors to network", () => {
    expect(classifyStripeError({ type: "StripeConnectionError" })).toBe("network");
  });

  it("falls back to unknown for unrecognized or non-Stripe shapes", () => {
    expect(classifyStripeError({ type: "StripePermissionError" })).toBe("unknown");
    expect(classifyStripeError(new Error("boom"))).toBe("unknown");
    expect(classifyStripeError(undefined)).toBe("unknown");
  });
});

describe("statusToReason", () => {
  it("treats a post-confirm requires_payment_method as a decline", () => {
    expect(statusToReason("requires_payment_method")).toBe("card_declined");
  });

  it("maps other non-succeeded statuses to unknown", () => {
    expect(statusToReason("requires_action")).toBe("unknown");
    expect(statusToReason("processing")).toBe("unknown");
    expect(statusToReason("canceled")).toBe("unknown");
  });
});
