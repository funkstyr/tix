// End-to-end smoke test for the reservation -> expire -> release flow.
// Assumes `docker compose up -d` is already running. Boots auth / tickets /
// orders / expiration as child processes, drives the PRD flow via HTTP/oRPC,
// and asserts the four domain events fire and the seat is restored.
//
// Exits 0 on success, non-zero with the failing step name on failure.

import { connect, type NatsConnection } from "@nats-io/transport-node";
import { randomUUID } from "node:crypto";
import process from "node:process";

import {
  ORDER_CREATED_V1,
  ORDER_EXPIRED_V1,
  ORDER_RESERVATION_RELEASED_V1,
  TICKETS_CREATED_V1,
} from "@tix/contracts/subjects";

import { authClient, ordersClient, pollTicketRestored, ticketsClient } from "./e2e-clients.ts";
import { env, RESTORE_TIMEOUT_MS, SERVICE_READY_TIMEOUT_MS } from "./e2e-env.ts";
import { runMigrations } from "./e2e-migrate.ts";
import { spawnAll, stopAll, waitForReady } from "./e2e-services.ts";
import { subscribeAll, type Subscription } from "./e2e-subscribers.ts";

let nats: NatsConnection | undefined;
let subscription: Subscription | undefined;
let currentStep = "init";

async function withStep<T>(name: string, body: () => Promise<T>): Promise<T> {
  currentStep = name;
  console.log(`▶ ${name}`);
  return body();
}

async function main(): Promise<void> {
  await withStep("migrate", runMigrations);

  await withStep("connect-nats", async () => {
    nats = await connect({ servers: env.NATS_URL });
  });

  await withStep("subscribe", async () => {
    if (!nats) throw new Error("nats not connected");
    subscription = await subscribeAll(nats);
  });

  await withStep("spawn-services", async () => {
    spawnAll();
  });

  await withStep("wait-ready", () => waitForReady(SERVICE_READY_TIMEOUT_MS));

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

  await withStep("wait-restore", () =>
    pollTicketRestored(tickets, ticket.id, 4, RESTORE_TIMEOUT_MS),
  );

  await withStep("assert-expired", async () => {
    const o = await orders.getById({ token: buyer.token, orderId: order.id });
    if (!o) throw new Error(`order ${order.id} not found after expiry`);
    if (o.status !== "expired") {
      throw new Error(`expected order.status="expired", got "${o.status}"`);
    }
  });

  await withStep("assert-events", async () => {
    if (!subscription) throw new Error("subscription missing");
    const subjects = new Set(subscription.observed.map((e) => e.subject));
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
  console.log(`   events  ${subscription?.observed.map((e) => e.subject).join(" → ") ?? ""}`);
}

async function shutdown(): Promise<void> {
  if (subscription) {
    try {
      await subscription.stop();
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
  await stopAll();
}

try {
  await main();
  await shutdown();
  process.exit(0);
} catch (err) {
  console.error(`\n✗ failed at step: ${currentStep}`);
  console.error(err);
  await shutdown();
  process.exit(1);
}
