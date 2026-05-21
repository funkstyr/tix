import { describe, expect, expectTypeOf, test } from "vitest";

import {
  type ReserveTicketInput,
  type ReserveTicketOutput,
  reserveTicketInput,
  reserveTicketOutput,
} from "./tickets-reserve";

const goodInput: ReserveTicketInput = {
  ticketId: "11111111-1111-4111-8111-111111111111",
  quantity: 2,
};

const goodOutput: ReserveTicketOutput = {
  ticketId: "11111111-1111-4111-8111-111111111111",
  quantityAvailable: 3,
  version: 2,
};

describe("reserveTicketInput", () => {
  test("accepts a known-good payload", () => {
    expect(() => reserveTicketInput.assert(goodInput)).not.toThrow();
  });

  test("rejects quantity = 0", () => {
    expect(() => reserveTicketInput.assert({ ...goodInput, quantity: 0 })).toThrow(/quantity/);
  });

  test("rejects a non-uuid ticketId", () => {
    expect(() => reserveTicketInput.assert({ ...goodInput, ticketId: "not-a-uuid" })).toThrow(
      /ticketId/,
    );
  });

  test("inferred type matches the documented shape", () => {
    expectTypeOf<ReserveTicketInput>().toEqualTypeOf<{
      ticketId: string;
      quantity: number;
    }>();
  });
});

describe("reserveTicketOutput", () => {
  test("accepts a known-good payload", () => {
    expect(() => reserveTicketOutput.assert(goodOutput)).not.toThrow();
  });

  test("inferred type matches the documented shape", () => {
    expectTypeOf<ReserveTicketOutput>().toEqualTypeOf<{
      ticketId: string;
      quantityAvailable: number;
      version: number;
    }>();
  });
});
