import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { dbSpan } from "./db-span.js";

describe("dbSpan", () => {
  it("wraps the effect in a db span and returns its value unchanged", async () => {
    const result = await Effect.runPromise(dbSpan("insert", "orders.orders", Effect.succeed(42)));
    expect(result).toBe(42);
  });

  it("propagates failure (the span records it, does not swallow)", async () => {
    const exit = await Effect.runPromiseExit(
      dbSpan("select", "orders.orders", Effect.fail(new Error("boom"))),
    );
    expect(exit._tag).toBe("Failure");
  });
});
