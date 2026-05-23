import { type } from "arktype";

export const orderCreatedV1 = type({
  "+": "reject",
  orderId: "string.uuid",
  ticketId: "string.uuid",
  buyerId: "string >= 1",
  quantity: "number.integer >= 1",
  priceCents: "number.integer >= 0",
  expiresAt: "string.date.iso",
  createdAt: "string.date.iso",
});

export type OrderCreatedV1 = typeof orderCreatedV1.infer;

export const orderCancelledV1 = type({
  "+": "reject",
  orderId: "string.uuid",
  // post-transition version of the order row — consumers apply the cancel only
  // when their local read-model is at `version - 1`, dropping stale redeliveries.
  version: "number.integer >= 1",
  cancelledAt: "string.date.iso",
});

export type OrderCancelledV1 = typeof orderCancelledV1.infer;

export const orderCompletedV1 = type({
  "+": "reject",
  orderId: "string.uuid",
  // post-transition version of the order row — consumers apply the complete only
  // when their local read-model is at `version - 1`, dropping stale redeliveries.
  version: "number.integer >= 1",
  completedAt: "string.date.iso",
});

export type OrderCompletedV1 = typeof orderCompletedV1.infer;

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

export const orderRecordOutput = type({
  "+": "reject",
  id: "string.uuid",
  buyerId: "string >= 1",
  ticketId: "string.uuid",
  quantity: "number.integer",
  priceCents: "number.integer >= 0",
  status: "'created' | 'awaiting_payment' | 'complete' | 'cancelled' | 'expired'",
  expiresAt: "string.date.iso",
  version: "number.integer",
  createdAt: "string.date.iso",
});

export const orderRecordOrNullOutput = orderRecordOutput.or("null");

export type OrderRecord = typeof orderRecordOutput.infer;

export const orderCreateInput = type({
  "+": "reject",
  token: "string >= 1",
  ticketId: "string.uuid",
  quantity: "number.integer >= 1",
});

export type OrderCreateInput = typeof orderCreateInput.infer;

export const orderGetByIdInput = type({
  "+": "reject",
  token: "string >= 1",
  orderId: "string.uuid",
});

export type OrderGetByIdInput = typeof orderGetByIdInput.infer;

export const ordersListInput = type({
  "+": "reject",
  token: "string >= 1",
  "limit?": "1 <= number.integer <= 200",
});

export type OrdersListInput = typeof ordersListInput.infer;

export const ordersListOutput = type({
  "+": "reject",
  items: orderRecordOutput.array(),
});

export type OrdersListOutput = typeof ordersListOutput.infer;

export type OrdersRouterClient = {
  create: (input: OrderCreateInput) => Promise<OrderRecord>;
  getById: (input: OrderGetByIdInput) => Promise<OrderRecord | null>;
  list: (input: OrdersListInput) => Promise<OrdersListOutput>;
};
