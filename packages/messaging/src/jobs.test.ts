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
  it("fires a delayed job", async () => {
    const conn = requireConnection();
    const queueName = `delay-${randomUUID()}`;

    let received: { orderId: string } | undefined;
    let resolveFired!: () => void;
    const fired = new Promise<void>((r) => {
      resolveFired = r;
    });

    const worker = createWorker<{ orderId: string }, never, never>(conn, {
      queueName,
      runtime,
      handler: (payload) =>
        Effect.sync(() => {
          received = payload;
          resolveFired();
        }),
    });

    const scheduler = createScheduler<{ orderId: string }>(conn, { queueName });

    try {
      await scheduler.scheduleDelayed("expire-order", { orderId: "o1" }, 200, "o1");

      // Asserting on wall-clock elapsed time is flaky in CI: promotion + processing
      // latency dwarfs the delay on a slow runner. We only verify the job *fires* with
      // its payload — the `10_000` test timeout fails the test if it never does. That a
      // scheduled job stays delayed (the delay is honored) is covered deterministically
      // by the counts() test below.
      await fired;

      expect(received).toEqual({ orderId: "o1" });
    } finally {
      await Promise.all([scheduler.close(), worker.close()]);
    }
  }, 10_000);

  it("dedupes a job scheduled twice with the same jobId", async () => {
    const conn = requireConnection();
    const queueName = `idem-${randomUUID()}`;

    // No worker is started: both schedules land in the delayed set, so counts() can
    // prove BullMQ deduped them by jobId — deterministically, with no timing window.
    const scheduler = createScheduler<{ orderId: string }>(conn, { queueName });

    try {
      await scheduler.scheduleDelayed("expire-order", { orderId: "o2" }, 60_000, "o2");
      await scheduler.scheduleDelayed("expire-order", { orderId: "o2" }, 60_000, "o2");

      const counts = await scheduler.counts();

      expect(counts.delayed).toBe(1);
    } finally {
      await scheduler.close();
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
