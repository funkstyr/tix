import { type } from "arktype";

export const paymentCreatedV1 = type({
  "+": "reject",
  id: "string.uuid",
  orderId: "string.uuid",
  stripeId: "string >= 1",
  amount: "number.integer >= 0",
  currency: "string >= 1",
  userId: "string >= 1",
  version: "number.integer >= 1",
});

export type PaymentCreatedV1 = typeof paymentCreatedV1.infer;

export type PaymentCreateInput = {
  token: string;
  orderId: string;
  paymentMethodId: string;
};

export type PaymentCreateOutput = {
  id: string;
  status: string;
};

export type PaymentsRouterClient = {
  create: (input: PaymentCreateInput) => Promise<PaymentCreateOutput>;
};
