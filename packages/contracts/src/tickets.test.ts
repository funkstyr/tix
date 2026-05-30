import { describe, expect, expectTypeOf, test } from "vitest";

import {
  type TicketCreatedV1,
  ticketCreatedV1,
  type TicketUpdatedV1,
  ticketUpdatedV1,
  ticketUpdateInput,
} from "./tickets";

const goodPayload: TicketCreatedV1 = {
  ticketId: "11111111-1111-4111-8111-111111111111",
  sellerId: "22222222-2222-4222-8222-222222222222",
  title: "Aphex Twin @ Warehouse",
  quantityTotal: 100,
  unitPriceCents: 4500,
  createdAt: "2026-05-20T12:00:00.000Z",
};

const goodUpdated: TicketUpdatedV1 = {
  ticketId: "11111111-1111-4111-8111-111111111111",
  sellerId: "22222222-2222-4222-8222-222222222222",
  title: "Aphex Twin @ Warehouse (rescheduled)",
  unitPriceCents: 5000,
  version: 2,
  updatedAt: "2026-05-21T12:00:00.000Z",
};

describe("ticketCreatedV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => ticketCreatedV1.assert(goodPayload)).not.toThrow();
  });

  test("rejects a payload missing a required field", () => {
    const { sellerId: _omitted, ...missing } = goodPayload;
    expect(() => ticketCreatedV1.assert(missing)).toThrow(/sellerId/);
  });

  test("rejects a payload with an extra unknown field", () => {
    expect(() => ticketCreatedV1.assert({ ...goodPayload, leakedField: "nope" })).toThrow(
      /leakedField/,
    );
  });

  test("inferred type matches the documented payload shape", () => {
    expectTypeOf<TicketCreatedV1>().toEqualTypeOf<{
      ticketId: string;
      sellerId: string;
      title: string;
      quantityTotal: number;
      unitPriceCents: number;
      createdAt: string;
    }>();
  });
});

describe("ticketUpdatedV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => ticketUpdatedV1.assert(goodUpdated)).not.toThrow();
  });

  test("rejects a payload with an extra unknown field", () => {
    expect(() => ticketUpdatedV1.assert({ ...goodUpdated, leakedField: "nope" })).toThrow(
      /leakedField/,
    );
  });

  test("rejects a version below 1", () => {
    expect(() => ticketUpdatedV1.assert({ ...goodUpdated, version: 0 })).toThrow(/version/);
  });
});

describe("ticketUpdateInput", () => {
  test("accepts a well-formed edit", () => {
    expect(() =>
      ticketUpdateInput.assert({
        token: "session-token",
        ticketId: goodUpdated.ticketId,
        title: "New title",
        unitPriceCents: 5000,
        expectedVersion: 1,
      }),
    ).not.toThrow();
  });

  test("rejects an empty title", () => {
    expect(() =>
      ticketUpdateInput.assert({
        token: "session-token",
        ticketId: goodUpdated.ticketId,
        title: "",
        unitPriceCents: 5000,
        expectedVersion: 1,
      }),
    ).toThrow(/title/);
  });
});
