// End-to-end smoke for the reservation -> expire -> release flow.
// Assumes `docker compose up -d` is already running. Boots auth / tickets /
// orders / expiration as child processes, drives the PRD flow via HTTP/oRPC,
// and asserts the four domain events fire and the seat is restored.

import { connect, type NatsConnection } from "@nats-io/transport-node";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AuthRouterClient } from "@tix/contracts/auth";
import type { OrdersRouterClient } from "@tix/contracts/orders";
import {
  ORDER_CREATED_V1,
  ORDER_EXPIRED_V1,
  ORDER_RESERVATION_RELEASED_V1,
  TICKETS_CREATED_V1,
} from "@tix/contracts/subjects";
import type { TicketsRouterClient } from "@tix/contracts/tickets";

import { authClient, ordersClient, pollTicketRestored, ticketsClient } from "../src/clients.ts";
import { env, RESTORE_TIMEOUT_MS, SERVICE_READY_TIMEOUT_MS } from "../src/env.ts";
import { runMigrations } from "../src/migrate.ts";
import { spawnAll, stopAll, waitForReady } from "../src/services.ts";
import { subscribeAll, type Subscription } from "../src/subscribers.ts";

type Identity = Awaited<ReturnType<AuthRouterClient["signUp"]>>;
type Ticket = Awaited<ReturnType<TicketsRouterClient["create"]>>;
type Order = Awaited<ReturnType<OrdersRouterClient["create"]>>;

describe("reserve -> expire -> release", () => {
  let nats: NatsConnection;
  let subscription: Subscription;
  let auth: AuthRouterClient;
  let tickets: TicketsRouterClient;
  let orders: OrdersRouterClient;

  let seller: Identity;
  let buyer: Identity;
  let ticket: Ticket;
  let order: Order;

  beforeAll(async () => {
    await runMigrations();
    nats = await connect({ servers: env.NATS_URL });
    subscription = await subscribeAll(nats);
    spawnAll();
    await waitForReady(SERVICE_READY_TIMEOUT_MS);

    auth = authClient();
    tickets = ticketsClient();
    orders = ordersClient();
  });

  afterAll(async () => {
    try {
      await subscription?.stop();
    } catch {
      // best effort
    }
    try {
      await nats?.close();
    } catch {
      // best effort
    }
    await stopAll();
  });

  test("seller signs up and lists a ticket", async () => {
    seller = await auth.signUp({
      email: `seller-${randomUUID().slice(0, 8)}@example.com`,
      password: "correct-horse-battery",
      name: "Seller",
    });

    ticket = await tickets.create({
      token: seller.token,
      title: "GA pass",
      quantityTotal: 4,
      unitPriceCents: 5000,
    });

    expect(ticket.id).toBeTruthy();
  });

  test("buyer reserves two seats", async () => {
    buyer = await auth.signUp({
      email: `buyer-${randomUUID().slice(0, 8)}@example.com`,
      password: "correct-horse-battery",
      name: "Buyer",
    });

    order = await orders.create({ token: buyer.token, ticketId: ticket.id, quantity: 2 });

    const t = await tickets.getById({ ticketId: ticket.id });
    expect(t).not.toBeNull();
    expect(t?.quantityAvailable).toBe(2);
  });

  test("expiration restores the seats", async () => {
    await pollTicketRestored(tickets, ticket.id, 4, RESTORE_TIMEOUT_MS);
    const t = await tickets.getById({ ticketId: ticket.id });
    expect(t?.quantityAvailable).toBe(4);
  });

  test("order ends up expired", async () => {
    const o = await orders.getById({ token: buyer.token, orderId: order.id });
    expect(o).not.toBeNull();
    expect(o?.status).toBe("expired");
  });

  test("required NATS events were observed", () => {
    const subjects = new Set(subscription.observed.map((e) => e.subject));
    expect(subjects).toContain(TICKETS_CREATED_V1);
    expect(subjects).toContain(ORDER_CREATED_V1);
    expect(subjects).toContain(ORDER_EXPIRED_V1);
    expect(subjects).toContain(ORDER_RESERVATION_RELEASED_V1);
  });
});
