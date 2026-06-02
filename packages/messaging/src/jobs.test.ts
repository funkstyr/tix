import type { ConnectionOptions } from "bullmq";
import { Effect, Layer, ManagedRuntime } from "effect";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createScheduler, createWorker } from "./jobs.ts";

const runtime = ManagedRuntime.make(Layer.empty);

const dockerAvailable = ((): boolean => {
  if (process.env["DOCKER_HOST"]) return true;
  const home = process.env["HOME"] ?? "";
  const candidates = [
    "/var/run/docker.sock",
    `${home}/.docker/run/docker.sock`,
    `${home}/.colima/default/docker.sock`,
    `${home}/.orbstack/run/docker.sock`,
  ];
  return candidates.some((p) => existsSync(p));
})();

let container: StartedTestContainer | undefined;
let connection: ConnectionOptions | undefined;

function requireConnection(): ConnectionOptions {
  if (!connection) throw new Error("docker container not started");
  return connection;
}

beforeAll(async () => {
  if (!dockerAvailable) return;
  container = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  connection = { host: container.getHost(), port: container.getMappedPort(6379) };
}, 60_000);

afterAll(async () => {
  await container?.stop();
});

describe.skipIf(!dockerAvailable)("@tix/messaging/jobs", () => {
  it("fires a delayed job within the requested delay window", async () => {
    const conn = requireConnection();
    const queueName = `delay-${randomUUID()}`;

    let firedAt = 0;
    let resolveFired!: () => void;
    const fired = new Promise<void>((r) => {
      resolveFired = r;
    });

    const worker = createWorker<{ orderId: string }, never, never>(conn, {
      queueName,
      runtime,
      handler: () =>
        Effect.sync(() => {
          firedAt = Date.now();
          resolveFired();
        }),
    });

    const scheduler = createScheduler<{ orderId: string }>(conn, { queueName });

    try {
      const scheduledAt = Date.now();
      await scheduler.scheduleDelayed("expire-order", { orderId: "o1" }, 200, "o1");
      await fired;

      const elapsed = firedAt - scheduledAt;
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await Promise.all([scheduler.close(), worker.close()]);
    }
  }, 10_000);

  it("invokes the handler exactly once when scheduled twice with the same jobId", async () => {
    const conn = requireConnection();
    const queueName = `idem-${randomUUID()}`;

    // Window we wait after both schedules to verify no second invocation arrives.
    const observationWindowMs = 1000;

    let invocations = 0;
    const worker = createWorker<{ orderId: string }, never, never>(conn, {
      queueName,
      runtime,
      handler: () =>
        Effect.sync(() => {
          invocations++;
        }),
    });

    const scheduler = createScheduler<{ orderId: string }>(conn, { queueName });

    try {
      await scheduler.scheduleDelayed("expire-order", { orderId: "o2" }, 100, "o2");
      await scheduler.scheduleDelayed("expire-order", { orderId: "o2" }, 100, "o2");

      await new Promise((r) => setTimeout(r, observationWindowMs));

      expect(invocations).toBe(1);
    } finally {
      await Promise.all([scheduler.close(), worker.close()]);
    }
  }, 10_000);

  it("surfaces queue job counts via counts()", async () => {
    const conn = requireConnection();
    const queueName = `counts-${randomUUID()}`;

    // No worker is started, so a delayed job stays in the queue and counts() can observe it.
    const scheduler = createScheduler<{ orderId: string }>(conn, { queueName });

    try {
      await scheduler.scheduleDelayed("expire-order", { orderId: "o4" }, 60_000, "o4");

      const counts = await scheduler.counts();

      expect(counts.delayed).toBe(1);
      expect(counts.waiting).toBe(0);
      expect(counts.active).toBe(0);
    } finally {
      await scheduler.close();
    }
  }, 10_000);

  it("surfaces handler errors via the BullMQ failed event", async () => {
    const conn = requireConnection();
    const queueName = `fail-${randomUUID()}`;

    const worker = createWorker<{ orderId: string }, never, never>(conn, {
      queueName,
      runtime,
      handler: () =>
        Effect.sync(() => {
          throw new Error("boom");
        }),
    });

    let resolveFailure!: (err: Error) => void;
    const failure = new Promise<Error>((r) => {
      resolveFailure = r;
    });
    worker.on("failed", (_job, err) => {
      resolveFailure(err);
    });

    const scheduler = createScheduler<{ orderId: string }>(conn, { queueName });

    try {
      await scheduler.scheduleDelayed("expire-order", { orderId: "o3" }, 50, "o3");

      const err = await failure;
      expect(err.message).toBe("boom");
    } finally {
      await Promise.all([scheduler.close(), worker.close()]);
    }
  }, 10_000);
});
