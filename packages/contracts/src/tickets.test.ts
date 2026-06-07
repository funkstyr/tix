import { describe, expect, test } from "vitest";

import {
  type TicketCreatedV1,
  ticketCreatedV1,
  type TicketUpdatedV1,
  ticketUpdatedV1,
  ticketUpdateInput,
  ticketsListInput,
  ticketsListMineInput,
  ticketsListOutput,
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

  // Event schemas are strict-by-policy (`"+": "reject"`); pinned once here for
  // this aggregate rather than re-tested per schema.
  test("rejects unknown fields", () => {
    expect(() => ticketCreatedV1.assert({ ...goodPayload, leakedField: "nope" })).toThrow(
      /leakedField/,
    );
  });
});

describe("ticketUpdatedV1", () => {
  test("accepts a known-good payload", () => {
    expect(() => ticketUpdatedV1.assert(goodUpdated)).not.toThrow();
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

describe("ticketsListInput", () => {
  test("accepts the new optional filter/sort/cursor fields", () => {
    expect(() =>
      ticketsListInput.assert({
        limit: 20,
        q: "aphex",
        sort: "price_asc",
        availableOnly: true,
        cursor: "abc",
      }),
    ).not.toThrow();
  });

  test("accepts an empty object (all fields optional)", () => {
    expect(() => ticketsListInput.assert({})).not.toThrow();
  });

  test("rejects an unknown sort value", () => {
    expect(() => ticketsListInput.assert({ sort: "cheapest" })).toThrow(/sort/);
  });
});

describe("ticketsListMineInput", () => {
  test("accepts token plus sort + cursor", () => {
    expect(() =>
      ticketsListMineInput.assert({ token: "t", sort: "newest", cursor: "abc" }),
    ).not.toThrow();
  });
});

describe("ticketsListOutput", () => {
  test("requires nextCursor (string or null)", () => {
    expect(() => ticketsListOutput.assert({ items: [], nextCursor: null })).not.toThrow();
    expect(() => ticketsListOutput.assert({ items: [] })).toThrow(/nextCursor/);
  });
});
