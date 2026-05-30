import { describe, expect, test } from "vitest";

import {
  type OrderCancelInput,
  type OrderCancelOutput,
  type OrderCancelledV1,
  type OrderCompletedV1,
  type OrderCreatedV1,
  type OrderExpiredV1,
  type OrderReservationReleasedV1,
  orderCancelInput,
  orderCancelOutput,
  orderCancelledV1,
  orderCompletedV1,
  orderCreatedV1,
  orderExpiredV1,
  orderReservationReleasedV1,
} from "./orders";

const goodCreated: OrderCreatedV1 = {
  orderId: "33333333-3333-4333-8333-333333333333",
  ticketId: "11111111-1111-4111-8111-111111111111",
  buyerId: "44444444-4444-4444-8444-444444444444",
  quantity: 2,
  priceCents: 10_000,
  expiresAt: "2026-05-20T12:15:00.000Z",
  createdAt: "2026-05-20T12:00:00.000Z",
};

const goodCancelled: OrderCancelledV1 = {
  orderId: "33333333-3333-4333-8333-333333333333",
  version: 2,
  cancelledAt: "2026-05-20T12:10:00.000Z",
};

const goodCompleted: OrderCompletedV1 = {
  orderId: "33333333-3333-4333-8333-333333333333",
  version: 2,
  completedAt: "2026-05-20T12:10:00.000Z",
};

const goodExpired: OrderExpiredV1 = {
  orderId: "33333333-3333-4333-8333-333333333333",
  expiredAt: "2026-05-20T12:15:00.000Z",
};

const goodReleased: OrderReservationReleasedV1 = {
  orderId: "33333333-3333-4333-8333-333333333333",
  ticketId: "11111111-1111-4111-8111-111111111111",
  quantity: 2,
  releasedAt: "2026-05-20T12:15:00.000Z",
};

describe("orderCreatedV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => orderCreatedV1.assert(goodCreated)).not.toThrow();
  });

  // Event schemas are strict-by-policy (`"+": "reject"`). The behaviour is
  // identical across every event schema in this package, so it's pinned once
  // here rather than re-tested per schema.
  test("rejects unknown fields", () => {
    expect(() => orderCreatedV1.assert({ ...goodCreated, leakedField: "nope" })).toThrow(
      /leakedField/,
    );
  });
});

describe("orderCancelledV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => orderCancelledV1.assert(goodCancelled)).not.toThrow();
  });

  test("rejects a non-positive version", () => {
    expect(() => orderCancelledV1.assert({ ...goodCancelled, version: 0 })).toThrow(/version/);
  });
});

describe("orderCompletedV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => orderCompletedV1.assert(goodCompleted)).not.toThrow();
  });

  test("rejects a non-positive version", () => {
    expect(() => orderCompletedV1.assert({ ...goodCompleted, version: 0 })).toThrow(/version/);
  });
});

describe("orderExpiredV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => orderExpiredV1.assert(goodExpired)).not.toThrow();
  });
});

describe("orderReservationReleasedV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => orderReservationReleasedV1.assert(goodReleased)).not.toThrow();
  });
});

const goodCancelInput: OrderCancelInput = {
  token: "session-token",
  orderId: "33333333-3333-4333-8333-333333333333",
};

describe("orderCancelInput", () => {
  test("accepts a known-good input", () => {
    expect(() => orderCancelInput.assert(goodCancelInput)).not.toThrow();
  });

  test("rejects a non-uuid orderId", () => {
    expect(() => orderCancelInput.assert({ ...goodCancelInput, orderId: "nope" })).toThrow(
      /orderId/,
    );
  });
});

describe("orderCancelOutput", () => {
  test("accepts a cancelled order record", () => {
    const cancelled: OrderCancelOutput = {
      id: "33333333-3333-4333-8333-333333333333",
      buyerId: "44444444-4444-4444-8444-444444444444",
      ticketId: "11111111-1111-4111-8111-111111111111",
      quantity: 2,
      priceCents: 10_000,
      status: "cancelled",
      expiresAt: "2026-05-20T12:15:00.000Z",
      version: 2,
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    expect(() => orderCancelOutput.assert(cancelled)).not.toThrow();
  });
});
