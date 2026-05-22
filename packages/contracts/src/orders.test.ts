import { describe, expect, expectTypeOf, test } from "vitest";

import {
  type OrderCancelledV1,
  type OrderCompletedV1,
  type OrderCreatedV1,
  type OrderExpiredV1,
  type OrderReservationReleasedV1,
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

  test("rejects a payload missing a required field", () => {
    const { buyerId: _omitted, ...missing } = goodCreated;
    expect(() => orderCreatedV1.assert(missing)).toThrow(/buyerId/);
  });

  test("rejects a payload with an extra unknown field", () => {
    expect(() => orderCreatedV1.assert({ ...goodCreated, leakedField: "nope" })).toThrow(
      /leakedField/,
    );
  });

  test("inferred type matches the documented payload shape", () => {
    expectTypeOf<OrderCreatedV1>().toEqualTypeOf<{
      orderId: string;
      ticketId: string;
      buyerId: string;
      quantity: number;
      priceCents: number;
      expiresAt: string;
      createdAt: string;
    }>();
  });
});

describe("orderCancelledV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => orderCancelledV1.assert(goodCancelled)).not.toThrow();
  });

  test("rejects a payload missing a required field", () => {
    const { version: _omitted, ...missing } = goodCancelled;
    expect(() => orderCancelledV1.assert(missing)).toThrow(/version/);
  });

  test("rejects a payload with an extra unknown field", () => {
    expect(() => orderCancelledV1.assert({ ...goodCancelled, leakedField: "nope" })).toThrow(
      /leakedField/,
    );
  });

  test("rejects a non-positive version", () => {
    expect(() => orderCancelledV1.assert({ ...goodCancelled, version: 0 })).toThrow(/version/);
  });

  test("inferred type matches the documented payload shape", () => {
    expectTypeOf<OrderCancelledV1>().toEqualTypeOf<{
      orderId: string;
      version: number;
      cancelledAt: string;
    }>();
  });
});

describe("orderCompletedV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => orderCompletedV1.assert(goodCompleted)).not.toThrow();
  });

  test("rejects a payload missing a required field", () => {
    const { version: _omitted, ...missing } = goodCompleted;
    expect(() => orderCompletedV1.assert(missing)).toThrow(/version/);
  });

  test("rejects a payload with an extra unknown field", () => {
    expect(() => orderCompletedV1.assert({ ...goodCompleted, leakedField: "nope" })).toThrow(
      /leakedField/,
    );
  });

  test("rejects a non-positive version", () => {
    expect(() => orderCompletedV1.assert({ ...goodCompleted, version: 0 })).toThrow(/version/);
  });

  test("inferred type matches the documented payload shape", () => {
    expectTypeOf<OrderCompletedV1>().toEqualTypeOf<{
      orderId: string;
      version: number;
      completedAt: string;
    }>();
  });
});

describe("orderExpiredV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => orderExpiredV1.assert(goodExpired)).not.toThrow();
  });

  test("rejects a payload missing a required field", () => {
    const { expiredAt: _omitted, ...missing } = goodExpired;
    expect(() => orderExpiredV1.assert(missing)).toThrow(/expiredAt/);
  });

  test("rejects a payload with an extra unknown field", () => {
    expect(() => orderExpiredV1.assert({ ...goodExpired, leakedField: "nope" })).toThrow(
      /leakedField/,
    );
  });

  test("inferred type matches the documented payload shape", () => {
    expectTypeOf<OrderExpiredV1>().toEqualTypeOf<{
      orderId: string;
      expiredAt: string;
    }>();
  });
});

describe("orderReservationReleasedV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => orderReservationReleasedV1.assert(goodReleased)).not.toThrow();
  });

  test("rejects a payload missing a required field", () => {
    const { ticketId: _omitted, ...missing } = goodReleased;
    expect(() => orderReservationReleasedV1.assert(missing)).toThrow(/ticketId/);
  });

  test("rejects a payload with an extra unknown field", () => {
    expect(() =>
      orderReservationReleasedV1.assert({ ...goodReleased, leakedField: "nope" }),
    ).toThrow(/leakedField/);
  });

  test("inferred type matches the documented payload shape", () => {
    expectTypeOf<OrderReservationReleasedV1>().toEqualTypeOf<{
      orderId: string;
      ticketId: string;
      quantity: number;
      releasedAt: string;
    }>();
  });
});
