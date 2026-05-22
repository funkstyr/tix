import { type } from "arktype";

export const orderCreatedV1 = type({
  "+": "reject",
  orderId: "string.uuid",
  ticketId: "string.uuid",
  buyerId: "string >= 1",
  quantity: "number.integer >= 1",
  expiresAt: "string.date.iso",
  createdAt: "string.date.iso",
});

export type OrderCreatedV1 = typeof orderCreatedV1.infer;

export const orderExpiredV1 = type({
  "+": "reject",
  orderId: "string.uuid",
  expiredAt: "string.date.iso",
});

export type OrderExpiredV1 = typeof orderExpiredV1.infer;

export const orderReservationReleasedV1 = type({
  "+": "reject",
  orderId: "string.uuid",
  ticketId: "string.uuid",
  quantity: "number.integer >= 1",
  releasedAt: "string.date.iso",
});

export type OrderReservationReleasedV1 = typeof orderReservationReleasedV1.infer;

export type OrderCreateInput = {
  token: string;
  ticketId: string;
  quantity: number;
};

export type OrderRecord = {
  id: string;
  buyerId: string;
  ticketId: string;
  quantity: number;
  status: string;
  expiresAt: string;
  version: number;
  createdAt: string;
};

export type OrdersRouterClient = {
  create: (input: OrderCreateInput) => Promise<OrderRecord>;
  getById: (input: { orderId: string }) => Promise<OrderRecord | null>;
};
