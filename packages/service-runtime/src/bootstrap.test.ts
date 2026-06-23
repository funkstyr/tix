import { Effect, Exit, Scope } from "effect";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { acquireHttpServer, acquireStoppable } from "./bootstrap.ts";

describe("acquireStoppable", () => {
  it("starts the resource and stops it when the scope closes (LIFO)", async () => {
    const events: string[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireStoppable(async () => {
            events.push("started");
            return {
              stop: async () => {
                events.push("stopped");
              },
            };
          });
          events.push("in-scope");
        }),
      ),
    );

    expect(events).toEqual(["started", "in-scope", "stopped"]);
  });
});

describe("scoped boot failure", () => {
  it("finalizes already-acquired resources when a later one fails to start", async () => {
    // The partial-boot case: a service acquires relay/poller/consumers in order,
    // and one of the later consumers fails to start. The resources acquired before
    // it must still be torn down (LIFO on scope close) rather than leaked — no
    // dangling NATS consumer or db pool when boot fails halfway.
    const events: string[] = [];

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireStoppable(async () => {
            events.push("a-start");
            return {
              stop: async () => {
                events.push("a-stop");
              },
            };
          });
          yield* acquireStoppable(async () => {
            events.push("b-start");
            throw new Error("b failed to start");
          });
          events.push("unreachable");
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    // a acquired then released on unwind; b never fully acquired so it has no
    // finalizer; the body after b never runs.
    expect(events).toEqual(["a-start", "b-start", "a-stop"]);
  });
});

describe("acquireHttpServer", () => {
  it("serves while the scope is open and closes the listener after", async () => {
    const app = new Hono();
    app.get("/health", (c) => c.json({ ok: true }));

    const scope = await Effect.runPromise(Scope.make());
    const server = await Effect.runPromise(Scope.extend(acquireHttpServer(app, 0), scope));

    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected tcp address");

    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(res.ok).toBe(true);

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await expect(fetch(`http://127.0.0.1:${address.port}/health`)).rejects.toThrow(/fetch failed/);
  });
});
