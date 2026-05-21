import { describe, expect, expectTypeOf, test } from "vitest";

import { type TicketCreatedV1, ticketCreatedV1 } from "./tickets";

const goodPayload: TicketCreatedV1 = {
  ticketId: "11111111-1111-4111-8111-111111111111",
  sellerId: "22222222-2222-4222-8222-222222222222",
  title: "Aphex Twin @ Warehouse",
  quantityTotal: 100,
  unitPriceCents: 4500,
  createdAt: "2026-05-20T12:00:00.000Z",
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
