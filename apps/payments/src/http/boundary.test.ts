import { ORPCError } from "@orpc/server";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import {
  OrderForbidden,
  OrderNotFound,
  OrderNotPayable,
  PaymentIntentNotSucceeded,
} from "../domain/errors.ts";
import { makeRunHandler, toORPCError } from "./boundary.ts";

describe("toORPCError", () => {
  it("maps OrderNotFound to NOT_FOUND 'order not found'", () => {
    const e = toORPCError(new OrderNotFound({ orderId: "o1" }));

    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toBe("order not found");
  });

  it("maps OrderForbidden to FORBIDDEN with today's message", () => {
    const e = toORPCError(new OrderForbidden({ orderId: "o1" }));

    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toBe("order belongs to another user");
  });

  it("maps OrderNotPayable to CONFLICT 409 with reason not_payable + status", () => {
    const e = toORPCError(new OrderNotPayable({ orderId: "o1", status: "cancelled" }));

    expect(e.code).toBe("CONFLICT");
    expect(e.status).toBe(409);
    expect(e.data).toEqual({ reason: "not_payable", status: "cancelled" });
  });

  it("maps PaymentIntentNotSucceeded to UNPROCESSABLE_CONTENT 422 with reason + status", () => {
    const e = toORPCError(new PaymentIntentNotSucceeded({ status: "requires_payment_method" }));

    expect(e.code).toBe("UNPROCESSABLE_CONTENT");
    expect(e.status).toBe(422);
    expect(e.data).toEqual({ reason: "intent_not_succeeded", status: "requires_payment_method" });
  });
});

describe("makeRunHandler", () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const run = makeRunHandler(runtime);

  it("returns the program's success value", async () => {
    await expect(run(Effect.succeed(42))).resolves.toBe(42);
  });

  it("translates a tagged domain failure to its ORPCError", async () => {
    await expect(run(Effect.fail(new OrderNotFound({ orderId: "o1" })))).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "order not found",
    });
  });

  it("passes a raw ORPCError through unchanged", async () => {
    const original = new ORPCError("UNAUTHORIZED", { message: "invalid or expired session" });

    await expect(run(Effect.fail(original))).rejects.toBe(original);
  });
});
