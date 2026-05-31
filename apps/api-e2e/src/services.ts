import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  env,
  repoRoot,
  RESERVATION_TTL_MS,
  TEST_BETTER_AUTH_SECRET,
  TEST_SERVICE_TOKEN,
} from "./env.ts";

type ServiceName = "auth" | "tickets" | "orders" | "expiration";

type ServiceSpec = {
  name: ServiceName;
  env: NodeJS.ProcessEnv;
};

const children: { name: ServiceName; child: ChildProcess }[] = [];

function spawnService(spec: ServiceSpec): void {
  // `node` runs the service's TypeScript directly via native type-stripping
  // (the repo enforces `erasableSyntaxOnly`), so no tsx/transpile step is needed.
  const child = spawn("pnpm", ["--filter", spec.name, "exec", "node", "src/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (buf: Buffer) => {
    process.stdout.write(`[${spec.name}] ${buf.toString()}`);
  });
  child.stderr?.on("data", (buf: Buffer) => {
    process.stderr.write(`[${spec.name}] ${buf.toString()}`);
  });
  child.once("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[${spec.name}] exited unexpectedly with code=${code} signal=${signal ?? ""}`);
    }
  });

  children.push({ name: spec.name, child });
}

export function spawnAll(): void {
  spawnService({
    name: "auth",
    env: {
      DATABASE_URL: env.AUTH_DATABASE_URL,
      BETTER_AUTH_SECRET: TEST_BETTER_AUTH_SECRET,
      AUTH_BASE_URL: env.AUTH_BASE_URL,
    },
  });
  spawnService({
    name: "tickets",
    env: {
      DATABASE_URL: env.TICKETS_DATABASE_URL,
      AUTH_BASE_URL: env.AUTH_BASE_URL,
      NATS_URL: env.NATS_URL,
      TICKETS_SERVICE_TOKEN: TEST_SERVICE_TOKEN,
    },
  });
  spawnService({
    name: "orders",
    env: {
      DATABASE_URL: env.ORDERS_DATABASE_URL,
      AUTH_BASE_URL: env.AUTH_BASE_URL,
      TICKETS_BASE_URL: env.TICKETS_BASE_URL,
      TICKETS_SERVICE_TOKEN: TEST_SERVICE_TOKEN,
      NATS_URL: env.NATS_URL,
      RESERVATION_TTL_MS: String(RESERVATION_TTL_MS),
    },
  });
  spawnService({
    name: "expiration",
    env: {
      DATABASE_URL: env.EXPIRATION_DATABASE_URL,
      NATS_URL: env.NATS_URL,
      REDIS_URL: env.REDIS_URL,
    },
  });
}

async function waitForHealth(url: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop -- polling is inherently sequential
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    // eslint-disable-next-line no-await-in-loop -- backoff before the next poll
    await delay(250);
  }
  throw new Error(`service did not become healthy: ${url}`);
}

// expiration has no HTTP server; by the time auth/tickets/orders all report
// healthy, expiration's BullMQ worker has had time to register on the ORDERS
// stream, so we don't gate on it explicitly.
export async function waitForReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await Promise.all([
    waitForHealth(`${env.AUTH_BASE_URL}/health`, deadline),
    waitForHealth(`${env.TICKETS_BASE_URL}/health`, deadline),
    waitForHealth(`${env.ORDERS_BASE_URL}/health`, deadline),
  ]);
}

export async function stopAll(): Promise<void> {
  const alive = (): { name: ServiceName; child: ChildProcess }[] =>
    children.filter(({ child }) => child.exitCode === null && child.pid !== undefined);

  for (const { name, child } of alive()) {
    try {
      child.kill("SIGTERM");
    } catch (err) {
      console.error(`failed to SIGTERM ${name}:`, err);
    }
  }
  await delay(500);
  for (const { name, child } of alive()) {
    try {
      child.kill("SIGKILL");
    } catch (err) {
      console.error(`failed to SIGKILL ${name}:`, err);
    }
  }
}
