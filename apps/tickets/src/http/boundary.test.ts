import { ORPCError } from "@orpc/server";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import {
  ReservationConflict,
  SoldOut,
  TicketNotFound,
  TicketReserved,
  TicketStale,
} from "../domain/errors.ts";
import { makeRunHandler, toORPCError } from "./boundary.ts";

describe("toORPCError", () => {
  it("maps TicketNotFound to NOT_FOUND 'ticket not found'", () => {
    const e = toORPCError(new TicketNotFound({ ticketId: "t1" }));

    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toBe("ticket not found");
  });

  it("maps SoldOut to CONFLICT with reason sold_out", () => {
    const e = toORPCError(new SoldOut({ ticketId: "t1" }));

    expect(e.code).toBe("CONFLICT");
    expect(e.message).toBe("ticket is sold out");
    expect(e.data).toEqual({ reason: "sold_out" });
  });

  it("maps ReservationConflict to CONFLICT with reason version_conflict", () => {
    const e = toORPCError(new ReservationConflict({ ticketId: "t1" }));

    expect(e.code).toBe("CONFLICT");
    expect(e.message).toBe("reservation conflict after retry");
    expect(e.data).toEqual({ reason: "version_conflict" });
  });

  it("maps TicketReserved to CONFLICT with reason reserved", () => {
    const e = toORPCError(new TicketReserved({ ticketId: "t1" }));

    expect(e.code).toBe("CONFLICT");
    expect(e.message).toBe("cannot edit a reserved ticket");
    expect(e.data).toEqual({ reason: "reserved" });
  });

  it("maps TicketStale to CONFLICT with reason version_conflict", () => {
    const e = toORPCError(new TicketStale({ ticketId: "t1" }));

    expect(e.code).toBe("CONFLICT");
    expect(e.message).toBe("ticket was modified by someone else");
    expect(e.data).toEqual({ reason: "version_conflict" });
  });
});

describe("makeRunHandler", () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const run = makeRunHandler(runtime);

  it("returns the program's success value", async () => {
    await expect(run(Effect.succeed(42))).resolves.toBe(42);
  });

  it("translates a tagged domain failure to its ORPCError", async () => {
    await expect(run(Effect.fail(new SoldOut({ ticketId: "t1" })))).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "sold_out" },
    });
  });

  it("passes a raw ORPCError through unchanged", async () => {
    const original = new ORPCError("UNAUTHORIZED", { message: "missing or invalid service token" });

    await expect(run(Effect.fail(original))).rejects.toBe(original);
  });
});
