import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { runJob } from "./jobs.ts";

const runtime = ManagedRuntime.make(Layer.empty);

describe("runJob", () => {
  it("returns normally when the handler succeeds", async () => {
    let ran = false;
    await runJob(runtime, { queueName: "q", jobId: "1", jobName: "n" }, () =>
      Effect.sync(() => {
        ran = true;
      }),
    );
    expect(ran).toBe(true);
  });

  it("rethrows when the handler fails so BullMQ retries", async () => {
    await expect(
      runJob(runtime, { queueName: "q", jobId: "1", jobName: "n" }, () =>
        Effect.fail(new Error("boom")),
      ),
    ).rejects.toThrow("boom");
  });

  it("rethrows when the handler dies (defect)", async () => {
    await expect(
      runJob(runtime, { queueName: "q", jobId: "1", jobName: "n" }, () =>
        Effect.sync(() => {
          throw new Error("kaboom");
        }),
      ),
    ).rejects.toThrow(/kaboom/);
  });
});
