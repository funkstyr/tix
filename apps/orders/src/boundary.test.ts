import { ORPCError } from "@orpc/server";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { makeRunHandler, toORPCError } from "./boundary.ts";
import {
  BuyerIsSeller,
  OrderNotFound,
  ReservationConflict,
  SoldOut,
  TicketNotFound,
} from "./errors.ts";

describe("toORPCError", () => {
  it("maps TicketNotFound to NOT_FOUND 'ticket not found'", () => {
    const e = toORPCError(new TicketNotFound({ ticketId: "t1" }));

    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toBe("ticket not found");
  });

  it("maps BuyerIsSeller to FORBIDDEN with today's message", () => {
    const e = toORPCError(new BuyerIsSeller({ ticketId: "t1" }));

    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toBe("buyer cannot purchase their own ticket");
  });

  it("maps SoldOut to GONE 410 with reason sold_out", () => {
    const e = toORPCError(new SoldOut({ ticketId: "t1" }));

    expect(e.code).toBe("GONE");
    expect(e.status).toBe(410);
    expect(e.data).toEqual({ reason: "sold_out" });
  });

  it("maps ReservationConflict to CONFLICT 409 with reason race_lost", () => {
    const e = toORPCError(new ReservationConflict({ ticketId: "t1" }));

    expect(e.code).toBe("CONFLICT");
    expect(e.status).toBe(409);
    expect(e.data).toEqual({ reason: "race_lost" });
  });

  it("maps OrderNotFound to NOT_FOUND 'order not found'", () => {
    const e = toORPCError(new OrderNotFound({ orderId: "o1" }));

    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toBe("order not found");
  });
});

describe("makeRunHandler", () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const run = makeRunHandler(runtime);

  it("returns the program's success value", async () => {
    await expect(run(Effect.succeed(42))).resolves.toBe(42);
  });

  it("translates a tagged domain failure to its ORPCError", async () => {
    await expect(run(Effect.fail(new TicketNotFound({ ticketId: "t1" })))).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "ticket not found",
    });
  });

  it("passes a raw ORPCError through unchanged", async () => {
    const original = new ORPCError("UNAUTHORIZED", { message: "invalid or expired session" });

    await expect(run(Effect.fail(original))).rejects.toBe(original);
  });
});
