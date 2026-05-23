import type { Stripe, StripeElements } from "@stripe/stripe-js";
import { describe, expect, it, vi } from "vitest";

import type { GatewayRouterClient } from "@tix/contracts/gateway";

import { submitPayment } from "./submit-payment";

// Minimal shapes — `submitPayment` only touches `error.message`,
// `paymentMethod.id`, and the create call's input/output.
type SubmitFn = () => Promise<{ error?: { message: string } }>;
type CreatePaymentMethodFn = () => Promise<{
  paymentMethod?: { id: string };
  error?: { message: string };
}>;
type CreatePaymentFn = (input: unknown) => Promise<unknown>;

function makeStripe(createPaymentMethod: ReturnType<typeof vi.fn<CreatePaymentMethodFn>>): Stripe {
  return { createPaymentMethod } as unknown as Stripe;
}

function makeElements(submit: ReturnType<typeof vi.fn<SubmitFn>>): StripeElements {
  return { submit } as unknown as StripeElements;
}

function makeClient(impl: CreatePaymentFn): {
  client: GatewayRouterClient;
  create: ReturnType<typeof vi.fn<CreatePaymentFn>>;
} {
  const create = vi.fn<CreatePaymentFn>(impl);
  const client = { payments: { create } } as unknown as GatewayRouterClient;
  return { client, create };
}

describe("submitPayment", () => {
  it("calls payments.create with the paymentMethodId and returns ok on success", async () => {
    const submit = vi.fn<SubmitFn>().mockResolvedValue({});
    const createPaymentMethod = vi
      .fn<CreatePaymentMethodFn>()
      .mockResolvedValue({ paymentMethod: { id: "pm_test_123" } });
    const { client, create } = makeClient(async () => ({ id: "p_1", status: "succeeded" }));

    const result = await submitPayment({
      stripe: makeStripe(createPaymentMethod),
      elements: makeElements(submit),
      client,
      token: "tok_abc",
      orderId: "order_xyz",
    });

    expect(result).toEqual({ kind: "ok" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      token: "tok_abc",
      orderId: "order_xyz",
      paymentMethodId: "pm_test_123",
    });
  });

  it("returns the elements.submit error message and skips downstream calls", async () => {
    const submit = vi
      .fn<SubmitFn>()
      .mockResolvedValue({ error: { message: "Card number is incomplete" } });
    const createPaymentMethod = vi.fn<CreatePaymentMethodFn>();
    const { client, create } = makeClient(async () => ({}));

    const result = await submitPayment({
      stripe: makeStripe(createPaymentMethod),
      elements: makeElements(submit),
      client,
      token: "tok_abc",
      orderId: "order_xyz",
    });

    expect(result).toEqual({ kind: "error", message: "Card number is incomplete" });
    expect(createPaymentMethod).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the createPaymentMethod error message and skips payments.create", async () => {
    const submit = vi.fn<SubmitFn>().mockResolvedValue({});
    const createPaymentMethod = vi
      .fn<CreatePaymentMethodFn>()
      .mockResolvedValue({ error: { message: "Your card was declined" } });
    const { client, create } = makeClient(async () => ({}));

    const result = await submitPayment({
      stripe: makeStripe(createPaymentMethod),
      elements: makeElements(submit),
      client,
      token: "tok_abc",
      orderId: "order_xyz",
    });

    expect(result).toEqual({ kind: "error", message: "Your card was declined" });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the payments.create rejection message", async () => {
    const submit = vi.fn<SubmitFn>().mockResolvedValue({});
    const createPaymentMethod = vi
      .fn<CreatePaymentMethodFn>()
      .mockResolvedValue({ paymentMethod: { id: "pm_test_123" } });
    const { client } = makeClient(async () => {
      throw new Error("Order not payable");
    });

    const result = await submitPayment({
      stripe: makeStripe(createPaymentMethod),
      elements: makeElements(submit),
      client,
      token: "tok_abc",
      orderId: "order_xyz",
    });

    expect(result).toEqual({ kind: "error", message: "Order not payable" });
  });

  it("falls back to a generic message when payments.create rejects with a non-Error", async () => {
    const submit = vi.fn<SubmitFn>().mockResolvedValue({});
    const createPaymentMethod = vi
      .fn<CreatePaymentMethodFn>()
      .mockResolvedValue({ paymentMethod: { id: "pm_test_123" } });
    const { client } = makeClient(async () => {
      throw "boom";
    });

    const result = await submitPayment({
      stripe: makeStripe(createPaymentMethod),
      elements: makeElements(submit),
      client,
      token: "tok_abc",
      orderId: "order_xyz",
    });

    expect(result).toEqual({ kind: "error", message: "Payment failed" });
  });

  it("returns a 3DS-specific error when the PaymentIntent comes back as requires_action", async () => {
    const submit = vi.fn<SubmitFn>().mockResolvedValue({});
    const createPaymentMethod = vi
      .fn<CreatePaymentMethodFn>()
      .mockResolvedValue({ paymentMethod: { id: "pm_test_123" } });
    const { client } = makeClient(async () => ({ id: "p_1", status: "requires_action" }));

    const result = await submitPayment({
      stripe: makeStripe(createPaymentMethod),
      elements: makeElements(submit),
      client,
      token: "tok_abc",
      orderId: "order_xyz",
    });

    expect(result).toEqual({
      kind: "error",
      message: "Card requires additional verification — please try a different card",
    });
  });

  it("returns a processing-specific error when the PaymentIntent is still processing", async () => {
    const submit = vi.fn<SubmitFn>().mockResolvedValue({});
    const createPaymentMethod = vi
      .fn<CreatePaymentMethodFn>()
      .mockResolvedValue({ paymentMethod: { id: "pm_test_123" } });
    const { client } = makeClient(async () => ({ id: "p_1", status: "processing" }));

    const result = await submitPayment({
      stripe: makeStripe(createPaymentMethod),
      elements: makeElements(submit),
      client,
      token: "tok_abc",
      orderId: "order_xyz",
    });

    expect(result).toEqual({
      kind: "error",
      message: "Payment is still processing — refresh to see the final status",
    });
  });

  it("returns a generic decline error for other non-succeeded statuses", async () => {
    const submit = vi.fn<SubmitFn>().mockResolvedValue({});
    const createPaymentMethod = vi
      .fn<CreatePaymentMethodFn>()
      .mockResolvedValue({ paymentMethod: { id: "pm_test_123" } });
    const { client } = makeClient(async () => ({
      id: "p_1",
      status: "requires_payment_method",
    }));

    const result = await submitPayment({
      stripe: makeStripe(createPaymentMethod),
      elements: makeElements(submit),
      client,
      token: "tok_abc",
      orderId: "order_xyz",
    });

    expect(result).toEqual({
      kind: "error",
      message: "Payment failed — please try a different card",
    });
  });
});
