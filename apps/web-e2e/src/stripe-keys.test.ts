import { describe, expect, it } from "vitest";

import { resolveStripePublishableKey } from "./stripe-keys.ts";

describe("resolveStripePublishableKey", () => {
  it("falls back to the sample key when unset", () => {
    expect(resolveStripePublishableKey(undefined)).toMatch(/^pk_test_/);
  });

  it("falls back when the env var is an empty string (CI unset-secret case)", () => {
    // GitHub injects an unset secret as "" — the regression this guards.
    expect(resolveStripePublishableKey("")).toMatch(/^pk_test_/);
  });

  it("uses a provided key verbatim", () => {
    expect(resolveStripePublishableKey("pk_test_real123")).toBe("pk_test_real123");
  });
});
