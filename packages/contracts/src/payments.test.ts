import { describe, expect, test } from "vitest";

import { type PaymentCreatedV1, paymentCreatedV1 } from "./payments";

const goodPayload: PaymentCreatedV1 = {
  id: "55555555-5555-4555-8555-555555555555",
  orderId: "33333333-3333-4333-8333-333333333333",
  stripeId: "pi_3OabcDEFghIJklmn1234",
  amountCents: 4500,
  currency: "usd",
  userId: "44444444-4444-4444-8444-444444444444",
  version: 1,
  createdAt: "2026-05-22T12:00:00.000Z",
};

describe("paymentCreatedV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => paymentCreatedV1.assert(goodPayload)).not.toThrow();
  });

  // Event schemas are strict-by-policy (`"+": "reject"`); pinned once here for
  // this aggregate rather than re-tested per schema.
  test("rejects unknown fields", () => {
    expect(() => paymentCreatedV1.assert({ ...goodPayload, leakedField: "nope" })).toThrow(
      /leakedField/,
    );
  });

  test("rejects a stripeId without the pi_ prefix", () => {
    expect(() => paymentCreatedV1.assert({ ...goodPayload, stripeId: "ch_abc123" })).toThrow(
      /stripeId/,
    );
  });

  test("rejects a zero amount", () => {
    expect(() => paymentCreatedV1.assert({ ...goodPayload, amountCents: 0 })).toThrow(
      /amountCents/,
    );
  });

  test("rejects a currency that is not 3 chars", () => {
    expect(() => paymentCreatedV1.assert({ ...goodPayload, currency: "us" })).toThrow(/currency/);
  });
});
