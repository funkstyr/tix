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
