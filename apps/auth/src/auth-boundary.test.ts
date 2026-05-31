import { expect, it } from "@effect/vitest";
import { ORPCError } from "@orpc/server";
import { APIError } from "better-auth/api";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";

import { makeRunHandler, tryAuth } from "./auth-boundary.ts";

it.effect("maps a better-auth APIError into a typed ORPCError failure", () =>
  Effect.gen(function* () {
    const error = yield* tryAuth(() => {
      throw new APIError("UNAUTHORIZED", { message: "invalid email or password" });
    }).pipe(Effect.flip);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.status).toBe(401);
    expect(error.message).toBe("invalid email or password");
  }),
);

it.effect("passes an ORPCError through unchanged", () =>
  Effect.gen(function* () {
    const thrown = new ORPCError("CONFLICT", { message: "already exists" });

    const error = yield* tryAuth(() => {
      throw thrown;
    }).pipe(Effect.flip);

    expect(error).toBe(thrown);
  }),
);

it.effect("turns an unexpected throw into a defect, not a typed failure", () =>
  Effect.gen(function* () {
    const exit = yield* tryAuth(() => {
      throw new Error("database is down");
    }).pipe(Effect.exit);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.isDie(exit.cause)).toBe(true);
    }
  }),
);

it.effect("returns the resolved value on success", () =>
  Effect.gen(function* () {
    const value = yield* tryAuth(() => Promise.resolve({ ok: true }));

    expect(value).toEqual({ ok: true });
  }),
);

it("runs a handler program and rethrows a typed ORPCError at the boundary", async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const run = makeRunHandler(runtime);

  await expect(run(Effect.succeed("ok"))).resolves.toBe("ok");

  const orpc = new ORPCError("UNAUTHORIZED", { message: "nope" });
  await expect(run(Effect.fail(orpc))).rejects.toBe(orpc);

  await expect(run(Effect.die(new Error("boom")))).rejects.toThrow("boom");

  await runtime.dispose();
});
