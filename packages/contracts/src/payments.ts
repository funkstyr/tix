import { type } from "arktype";

export const paymentIntentStatus = type(
  "'canceled' | 'processing' | 'requires_action' | 'requires_capture' | 'requires_confirmation' | 'requires_payment_method' | 'succeeded'",
);

export type PaymentIntentStatus = typeof paymentIntentStatus.infer;

export const paymentCreatedV1 = type({
  "+": "reject",
  id: "string.uuid",
  orderId: "string.uuid",
  stripeId: /^pi_[A-Za-z0-9]+$/,
  amountCents: "number.integer >= 1",
  currency: "string == 3",
  userId: "string >= 1",
  version: "number.integer >= 1",
  createdAt: "string.date.iso",
});

export type PaymentCreatedV1 = typeof paymentCreatedV1.infer;

export type PaymentCreateInput = {
  token: string;
  orderId: string;
  paymentMethodId: string;
};

export type PaymentCreateOutput = {
  id: string;
  status: PaymentIntentStatus;
};

export type PaymentsRouterClient = {
  create: (input: PaymentCreateInput) => Promise<PaymentCreateOutput>;
};
