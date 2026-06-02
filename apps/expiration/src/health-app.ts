import { Effect } from "effect";
import { Hono } from "hono";

import { runReadiness } from "@tix/service-runtime/readiness";

import type { ExpirationRuntime } from "./runtime/runtime.ts";
import { Nats, Scheduler } from "./runtime/services.ts";

// Minimal health surface for the otherwise-headless expiration worker (ADR-0011 Tier 1).
// `/health` is liveness (process up); `/ready` pings Redis (via the BullMQ queue's job
// counts) and NATS so Kubernetes only routes — and only keeps alive — a worker whose
// dependencies are reachable.
export function createExpirationHealthApp(runtime: ExpirationRuntime): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ service: "expiration", ok: true }));

  app.get("/ready", async (c) => {
    const report = await runReadiness(runtime, "expiration", [
      {
        name: "redis",
        effect: Effect.gen(function* () {
          const scheduler = yield* Scheduler;
          yield* Effect.tryPromise(() => scheduler.counts());
        }),
      },
      {
        name: "nats",
        effect: Effect.gen(function* () {
          const nats = yield* Nats;
          if (nats.isClosed()) yield* Effect.fail(new Error("nats closed"));
        }),
      },
    ]);
    return c.json(report.body, report.status);
  });

  return app;
}
