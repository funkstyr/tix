import { ORPCError } from "@orpc/server";
import { Cause, Data, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { makeRunHandler, tryOrpc } from "./orpc-boundary.ts";

class Boom extends Data.TaggedError("Boom")<{ reason: string }> {}

const runtime = ManagedRuntime.make(Layer.empty);
const runHandler = makeRunHandler(
  runtime,
  (error: Boom) => new ORPCError("CONFLICT", { message: error.reason }),
);

afterAll(() => runtime.dispose());

describe("makeRunHandler", () => {
  it("returns the success value", async () => {
    await expect(runHandler(Effect.succeed(42))).resolves.toBe(42);
  });

  it("maps a domain failure through the translator", async () => {
    const failing: Effect.Effect<never, Boom> = Effect.fail(new Boom({ reason: "nope" }));
    await expect(runHandler(failing)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "nope",
    });
  });

  it("rethrows an ORPCError raised inside the program unchanged", async () => {
    const orpcError = new ORPCError("UNAUTHORIZED", { message: "no session" });
    await expect(runHandler(Effect.fail(orpcError))).rejects.toBe(orpcError);
  });

  it("surfaces a defect as a rejection (oRPC turns it into a 500)", async () => {
    await expect(runHandler(Effect.die(new Error("broken")))).rejects.toThrow("broken");
  });
});

describe("tryOrpc", () => {
  it("passes through resolved values", async () => {
    await expect(Effect.runPromise(tryOrpc(() => Promise.resolve("ok")))).resolves.toBe("ok");
  });

  it("lifts a thrown ORPCError into the typed failure channel", async () => {
    const orpcError = new ORPCError("NOT_FOUND", { message: "gone" });
    const exit = await Effect.runPromiseExit(tryOrpc(() => Promise.reject(orpcError)));
    expect(Exit.isFailure(exit) && Cause.isFailType(exit.cause)).toBe(true);
  });

  it("turns a non-ORPC throw into a defect", async () => {
    const exit = await Effect.runPromiseExit(tryOrpc(() => Promise.reject(new Error("boom"))));
    expect(Exit.isFailure(exit) && Cause.isDieType(exit.cause)).toBe(true);
  });
});
