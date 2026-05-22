import { describe, expect, expectTypeOf, test } from "vitest";

import {
  type PaymentCreateInput,
  type PaymentCreateOutput,
  type PaymentCreatedV1,
  type PaymentsRouterClient,
  paymentCreatedV1,
} from "./payments";

const goodPayload: PaymentCreatedV1 = {
  id: "55555555-5555-4555-8555-555555555555",
  orderId: "33333333-3333-4333-8333-333333333333",
  stripeId: "pi_3OabcDEFghIJklmn1234",
  amount: 4500,
  currency: "usd",
  userId: "44444444-4444-4444-8444-444444444444",
  version: 1,
};

describe("paymentCreatedV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => paymentCreatedV1.assert(goodPayload)).not.toThrow();
  });

  test("rejects a payload missing a required field", () => {
    const { stripeId: _omitted, ...missing } = goodPayload;
    expect(() => paymentCreatedV1.assert(missing)).toThrow(/stripeId/);
  });

  test("rejects a payload with an extra unknown field", () => {
    expect(() => paymentCreatedV1.assert({ ...goodPayload, leakedField: "nope" })).toThrow(
      /leakedField/,
    );
  });

  test("inferred type matches the documented payload shape", () => {
    expectTypeOf<PaymentCreatedV1>().toEqualTypeOf<{
      id: string;
      orderId: string;
      stripeId: string;
      amount: number;
      currency: string;
      userId: string;
      version: number;
    }>();
  });
});

describe("PaymentsRouterClient", () => {
  test("create input shape", () => {
    expectTypeOf<PaymentCreateInput>().toEqualTypeOf<{
      token: string;
      orderId: string;
      paymentMethodId: string;
    }>();
  });

  test("create output shape", () => {
    expectTypeOf<PaymentCreateOutput>().toEqualTypeOf<{
      id: string;
      status: string;
    }>();
  });

  test("client exposes create mutation", () => {
    expectTypeOf<PaymentsRouterClient["create"]>().toEqualTypeOf<
      (input: PaymentCreateInput) => Promise<PaymentCreateOutput>
    >();
  });
});
