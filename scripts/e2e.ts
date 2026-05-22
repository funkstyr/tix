// End-to-end smoke test for the reservation -> expire -> release flow.
// Assumes `docker compose up -d` is already running. Boots auth / tickets /
// orders / expiration as child processes, drives the PRD flow via HTTP/oRPC,
// and asserts the four domain events fire and the seat is restored.
//
// Exits 0 on success, non-zero with the failing step name on failure.

import { connect, type NatsConnection } from "@nats-io/transport-node";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import type { AuthRouterClient } from "@tix/contracts/auth";
import { orderCreatedV1, orderExpiredV1, orderReservationReleasedV1 } from "@tix/contracts/orders";
import { RPC_PREFIX } from "@tix/contracts/rpc";
import {
  ORDER_CREATED_V1,
  ORDER_EXPIRED_V1,
  ORDER_RESERVATION_RELEASED_V1,
  ORDERS_STREAM,
  TICKETS_CREATED_V1,
} from "@tix/contracts/subjects";
import { ticketCreatedV1 } from "@tix/contracts/tickets";
import { createConsumer, type RunningConsumer } from "@tix/messaging/jetstream";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const SERVICE_TOKEN = "e2e-service-token";
const BETTER_AUTH_SECRET = "e2e-better-auth-secret-must-be-at-least-32-characters-long";
const RESERVATION_TTL_MS = 5_000;
const RESTORE_TIMEOUT_MS = 30_000;
const SERVICE_READY_TIMEOUT_MS = 30_000;
const TICKETS_STREAM_NAME = "TICKETS";

const env = {
  AUTH_DATABASE_URL: envOr(
    "AUTH_DATABASE_URL",
    "postgres://auth_user:auth_dev@localhost:5432/tix?search_path=auth",
  ),
  TICKETS_DATABASE_URL: envOr(
    "TICKETS_DATABASE_URL",
    "postgres://tickets_user:tickets_dev@localhost:5432/tix?search_path=tickets",
  ),
  ORDERS_DATABASE_URL: envOr(
    "ORDERS_DATABASE_URL",
    "postgres://orders_user:orders_dev@localhost:5432/tix?search_path=orders",
  ),
  EXPIRATION_DATABASE_URL: envOr(
    "EXPIRATION_DATABASE_URL",
    "postgres://expiration_user:expiration_dev@localhost:5432/tix?search_path=expiration",
  ),
  // Used to drop/recreate per-service schemas: each per-service role only
  // owns its own schema, so it can't manage the lifecycle of the others.
  ADMIN_DATABASE_URL: envOr(
    "ADMIN_DATABASE_URL",
    "postgres://postgres:postgres@localhost:5432/tix",
  ),
  NATS_URL: envOr("NATS_URL", "nats://localhost:4222"),
  REDIS_URL: envOr("REDIS_URL", "redis://localhost:6379"),
  // Use 127.0.0.1 (not "localhost") so IPv6 resolution can't route us to a
  // stray dev server listening on ::1:<port> from another project.
  AUTH_BASE_URL: "http://127.0.0.1:4001",
  TICKETS_BASE_URL: "http://127.0.0.1:4002",
  ORDERS_BASE_URL: "http://127.0.0.1:4003",
};

type ObservedEvent = {
  subject: string;
  eventId: string;
  payload: unknown;
  observedAt: string;
};

const observed: ObservedEvent[] = [];
const children: { name: string; child: ChildProcess }[] = [];
const consumers: RunningConsumer[] = [];
let nats: NatsConnection | undefined;
let currentStep = "init";

function envOr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function record(subject: string, eventId: string, payload: unknown): void {
  observed.push({ subject, eventId, payload, observedAt: new Date().toISOString() });
  console.log(`  • observed ${subject} eventId=${eventId}`);
}

async function withStep<T>(name: string, body: () => Promise<T>): Promise<T> {
  currentStep = name;
  console.log(`▶ ${name}`);
  return body();
}

async function runMigrations(): Promise<void> {
  // The e2e owns its DB state end to end. Drop + recreate each per-service
  // schema as the admin before migrating, so a stale schema from an earlier
  // run (or a docker volume with old migrations) can't poison the test. Each
  // service then migrates as its own role into its own schema, with the
  // migration log scoped to that schema (not the default global `drizzle`
  // schema) so per-service roles don't need CREATE on the database.
  const targets = [
    { schema: "auth", role: "auth_user", url: env.AUTH_DATABASE_URL, folder: "apps/auth/drizzle" },
    {
      schema: "tickets",
      role: "tickets_user",
      url: env.TICKETS_DATABASE_URL,
      folder: "apps/tickets/drizzle",
    },
    {
      schema: "orders",
      role: "orders_user",
      url: env.ORDERS_DATABASE_URL,
      folder: "apps/orders/drizzle",
    },
    {
      schema: "expiration",
      role: "expiration_user",
      url: env.EXPIRATION_DATABASE_URL,
      folder: "apps/expiration/drizzle",
    },
  ] as const;

  const admin = postgres(env.ADMIN_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop -- serial setup against one admin connection
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${target.schema}" CASCADE`);
      // eslint-disable-next-line no-await-in-loop -- serial setup against one admin connection
      await admin.unsafe(`CREATE SCHEMA "${target.schema}" AUTHORIZATION ${target.role}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  for (const target of targets) {
    const sql = postgres(target.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const db = drizzle(sql);
      // eslint-disable-next-line no-await-in-loop -- migrate per service, sequential to avoid log contention
      await migrate(db, {
        migrationsFolder: path.join(repoRoot, target.folder),
        migrationsSchema: target.schema,
      });
    } finally {
      // eslint-disable-next-line no-await-in-loop -- close per-service connection before opening the next
      await sql.end({ timeout: 5 });
    }
  }
}

async function subscribeAll(nc: NatsConnection): Promise<void> {
  const group = `e2e-${randomUUID().replace(/-/g, "")}`;

  consumers.push(
    await createConsumer(nc, {
      stream: TICKETS_STREAM_NAME,
      subjectFilter: TICKETS_CREATED_V1,
      group: `${group}-tickets-created`,
      schema: ticketCreatedV1,
      handler: ({ subject, eventId, payload }) => {
        record(subject, eventId, payload);
      },
    }),
    await createConsumer(nc, {
      stream: ORDERS_STREAM,
      subjectFilter: ORDER_CREATED_V1,
      group: `${group}-order-created`,
      schema: orderCreatedV1,
      handler: ({ subject, eventId, payload }) => {
        record(subject, eventId, payload);
      },
    }),
    await createConsumer(nc, {
      stream: ORDERS_STREAM,
      subjectFilter: ORDER_EXPIRED_V1,
      group: `${group}-order-expired`,
      schema: orderExpiredV1,
      handler: ({ subject, eventId, payload }) => {
        record(subject, eventId, payload);
      },
    }),
    await createConsumer(nc, {
      stream: ORDERS_STREAM,
      subjectFilter: ORDER_RESERVATION_RELEASED_V1,
      group: `${group}-order-released`,
      schema: orderReservationReleasedV1,
      handler: ({ subject, eventId, payload }) => {
        record(subject, eventId, payload);
      },
    }),
  );
}

type ServiceSpec = {
  name: "auth" | "tickets" | "orders" | "expiration";
  env: NodeJS.ProcessEnv;
};

function spawnService(spec: ServiceSpec): void {
  const child = spawn("pnpm", ["--filter", spec.name, "exec", "tsx", "src/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, ...spec.env, LOG_LEVEL: process.env["LOG_LEVEL"] ?? "info" },
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

function spawnAll(): void {
  spawnService({
    name: "auth",
    env: {
      DATABASE_URL: env.AUTH_DATABASE_URL,
      BETTER_AUTH_SECRET,
      AUTH_BASE_URL: env.AUTH_BASE_URL,
    },
  });
  spawnService({
    name: "tickets",
    env: {
      DATABASE_URL: env.TICKETS_DATABASE_URL,
      AUTH_BASE_URL: env.AUTH_BASE_URL,
      NATS_URL: env.NATS_URL,
      TICKETS_SERVICE_TOKEN: SERVICE_TOKEN,
    },
  });
  spawnService({
    name: "orders",
    env: {
      DATABASE_URL: env.ORDERS_DATABASE_URL,
      AUTH_BASE_URL: env.AUTH_BASE_URL,
      TICKETS_BASE_URL: env.TICKETS_BASE_URL,
      TICKETS_SERVICE_TOKEN: SERVICE_TOKEN,
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

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
  await Promise.all([
    waitForHealth(`${env.AUTH_BASE_URL}/health`, deadline),
    waitForHealth(`${env.TICKETS_BASE_URL}/health`, deadline),
    waitForHealth(`${env.ORDERS_BASE_URL}/health`, deadline),
  ]);
  // expiration has no HTTP server; the BullMQ worker is up once it has logged
  // "expiration service started", but we don't gate on that explicitly — by
  // the time auth/tickets/orders all report healthy, expiration's startup
  // has had ample time to register the consumer on the ORDERS stream.
}

type OrdersClient = {
  create: (input: {
    token: string;
    ticketId: string;
    quantity: number;
  }) => Promise<{ id: string; status: string; expiresAt: string }>;
  getById: (input: {
    orderId: string;
  }) => Promise<{ id: string; status: string; quantity: number } | null>;
};

type TicketsClient = {
  create: (input: {
    token: string;
    title: string;
    quantityTotal: number;
    unitPriceCents: number;
  }) => Promise<{ id: string; quantityAvailable: number }>;
  getById: (input: {
    ticketId: string;
  }) => Promise<{ id: string; quantityAvailable: number; quantityTotal: number } | null>;
};

function authClient(): AuthRouterClient {
  const link = new RPCLink({ url: `${env.AUTH_BASE_URL}${RPC_PREFIX}` });
  return createORPCClient(link);
}

function ticketsClient(): TicketsClient {
  const link = new RPCLink({ url: `${env.TICKETS_BASE_URL}${RPC_PREFIX}` });
  return createORPCClient(link);
}

function ordersClient(): OrdersClient {
  const link = new RPCLink({ url: `${env.ORDERS_BASE_URL}${RPC_PREFIX}` });
  return createORPCClient(link);
}

async function pollTicketRestored(
  client: TicketsClient,
  ticketId: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + RESTORE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- polling is inherently sequential
    const t = await client.getById({ ticketId });
    if (t && t.quantityAvailable === expected) return;
    // eslint-disable-next-line no-await-in-loop -- backoff before the next poll
    await delay(250);
  }
  throw new Error(
    `ticket ${ticketId} did not restore to quantityAvailable=${expected} within ${RESTORE_TIMEOUT_MS}ms`,
  );
}

async function main(): Promise<void> {
  await withStep("migrate", runMigrations);

  await withStep("connect-nats", async () => {
    nats = await connect({ servers: env.NATS_URL });
  });

  await withStep("subscribe", async () => {
    if (!nats) throw new Error("nats not connected");
    await subscribeAll(nats);
  });

  await withStep("spawn-services", async () => {
    spawnAll();
  });

  await withStep("wait-ready", waitForReady);

  const auth = authClient();
  const tickets = ticketsClient();
  const orders = ordersClient();

  const sellerEmail = `seller-${randomUUID().slice(0, 8)}@example.com`;
  const buyerEmail = `buyer-${randomUUID().slice(0, 8)}@example.com`;

  const seller = await withStep("seller-signup", () =>
    auth.signUp({ email: sellerEmail, password: "correct-horse-battery", name: "Seller" }),
  );

  const ticket = await withStep("ticket-create", () =>
    tickets.create({
      token: seller.token,
      title: "GA pass",
      quantityTotal: 4,
      unitPriceCents: 5000,
    }),
  );

  const buyer = await withStep("buyer-signup", () =>
    auth.signUp({ email: buyerEmail, password: "correct-horse-battery", name: "Buyer" }),
  );

  const order = await withStep("order-create", () =>
    orders.create({ token: buyer.token, ticketId: ticket.id, quantity: 2 }),
  );

  await withStep("assert-reserved", async () => {
    const t = await tickets.getById({ ticketId: ticket.id });
    if (!t) throw new Error("ticket vanished after order.create");
    if (t.quantityAvailable !== 2) {
      throw new Error(`expected quantityAvailable=2 after reservation, got ${t.quantityAvailable}`);
    }
  });

  await withStep("wait-restore", () => pollTicketRestored(tickets, ticket.id, 4));

  await withStep("assert-expired", async () => {
    const o = await orders.getById({ orderId: order.id });
    if (!o) throw new Error(`order ${order.id} not found after expiry`);
    if (o.status !== "expired") {
      throw new Error(`expected order.status="expired", got "${o.status}"`);
    }
  });

  await withStep("assert-events", async () => {
    const subjects = new Set(observed.map((e) => e.subject));
    const required = [
      TICKETS_CREATED_V1,
      ORDER_CREATED_V1,
      ORDER_EXPIRED_V1,
      ORDER_RESERVATION_RELEASED_V1,
    ];
    const missing = required.filter((s) => !subjects.has(s));
    if (missing.length > 0) {
      throw new Error(`missing observed events: ${missing.join(", ")}`);
    }
  });

  console.log("\n✅ e2e flow passed");
  console.log(`   ticket  ${ticket.id}`);
  console.log(`   order   ${order.id}`);
  console.log(`   events  ${observed.map((e) => e.subject).join(" → ")}`);
}

async function shutdown(code: number): Promise<void> {
  for (const c of consumers) {
    try {
      // eslint-disable-next-line no-await-in-loop -- stop consumers serially for clean NATS shutdown
      await c.stop();
    } catch {
      // best effort
    }
  }
  if (nats) {
    try {
      await nats.close();
    } catch {
      // best effort
    }
  }
  for (const { name, child } of children) {
    if (child.exitCode === null && child.pid !== undefined) {
      try {
        child.kill("SIGTERM");
      } catch (err) {
        console.error(`failed to SIGTERM ${name}:`, err);
      }
    }
  }
  await delay(500);
  for (const { name, child } of children) {
    if (child.exitCode === null && child.pid !== undefined) {
      try {
        child.kill("SIGKILL");
      } catch (err) {
        console.error(`failed to SIGKILL ${name}:`, err);
      }
    }
  }
  process.exit(code);
}

main().then(
  () => shutdown(0),
  (err: unknown) => {
    console.error(`\n✗ failed at step: ${currentStep}`);
    console.error(err);
    void shutdown(1);
  },
);
