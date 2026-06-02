import { Effect, ManagedRuntime, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { runReadiness } from "./readiness.js";

const runtime = ManagedRuntime.make(Layer.empty);

describe("runReadiness", () => {
  it("returns 200 with all checks ok when every check succeeds", async () => {
    const result = await runReadiness(runtime, "orders", [
      { name: "db", effect: Effect.void },
      { name: "nats", effect: Effect.void },
    ]);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      service: "orders",
      ready: true,
      checks: { db: "ok", nats: "ok" },
    });
  });

  it("returns 503 and marks the failing check when one check fails", async () => {
    const result = await runReadiness(runtime, "orders", [
      { name: "db", effect: Effect.void },
      { name: "nats", effect: Effect.fail(new Error("closed")) },
    ]);
    expect(result.status).toBe(503);
    expect(result.body.ready).toBe(false);
    expect(result.body.checks.db).toBe("ok");
    expect(result.body.checks.nats).toBe("failed");
  });

  it("treats a check that exceeds the timeout as failed", async () => {
    const result = await runReadiness(
      runtime,
      "orders",
      [{ name: "db", effect: Effect.never }],
      50,
    );
    expect(result.status).toBe(503);
    expect(result.body.checks.db).toBe("failed");
  });
});
