import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dockerAvailable } from "@tix/test-helpers/docker-available";
import { requireValue } from "@tix/test-helpers/require-value";
import { waitFor } from "@tix/test-helpers/wait-for";

import {
  type CanaryStack,
  type CanaryStackResources,
  startCanaryStack,
} from "./start-canary-stack.ts";

let pgContainer: StartedTestContainer | undefined;
let natsContainer: StartedTestContainer | undefined;
let stack: CanaryStackResources | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "gateway_canary",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/gateway_canary`;
  const natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;

  stack = await startCanaryStack(pgUrl, natsUrl);
}, 240_000);

afterAll(async () => {
  await stack?.shutdown();
  await natsContainer?.stop();
  await pgContainer?.stop();
});

function getStack(): CanaryStack {
  return requireValue(stack, "stack");
}

describe.skipIf(!dockerAvailable)("gateway canary: signup → ticket → order → pay", () => {
  it("completes the Buyer flow end-to-end with the Order finishing in `complete`", async () => {
    const { authClient, gatewayClient } = getStack();

    const seller = await authClient.signUp({
      email: `seller-${Date.now()}@canary.test`,
      password: "correct-horse-battery",
      name: "Canary Seller",
    });
    const buyer = await authClient.signUp({
      email: `buyer-${Date.now()}@canary.test`,
      password: "correct-horse-battery",
      name: "Canary Buyer",
    });

    const ticket = await gatewayClient.tickets.create({
      token: seller.token,
      title: "Canary Show @ The Venue",
      quantityTotal: 4,
      unitPriceCents: 4_500,
    });
    expect(ticket.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ticket.quantityAvailable).toBe(4);

    await gatewayClient.tickets.create({
      token: seller.token,
      title: "Canary Show @ The Venue Night 2",
      quantityTotal: 2,
      unitPriceCents: 5_000,
    });

    // Assert that filter + keyset pagination round-trips through the gateway
    // (new optional fields on ticketsListInput/ticketsListOutput flow through
    // the generic delegate passthrough without any handler change).
    const filtered = await gatewayClient.tickets.list({ sort: "price_asc", limit: 1 });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.nextCursor).not.toBeNull();

    const order = await gatewayClient.orders.create({
      token: buyer.token,
      ticketId: ticket.id,
      quantity: 1,
    });
    expect(order.status).toBe("created");
    expect(order.buyerId).toBe(buyer.userId);
    expect(order.ticketId).toBe(ticket.id);

    // Payments needs its order_read_model projection (driven by order.created.v1
    // via NATS) before payments.create can find the order. Retry briefly until
    // the projection lands rather than sleeping a fixed duration.
    const payment = await waitFor(async () => {
      try {
        return await gatewayClient.payments.create({
          token: buyer.token,
          orderId: order.id,
          paymentMethodId: "pm_card_visa",
        });
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
    }, 5_000);
    expect(payment.status).toBe("succeeded");
    expect(payment.id).toMatch(/^[0-9a-f-]{36}$/);

    // payment.created.v1 → orders consumer → order.status = complete, version 2.
    const completed = await waitFor(async () => {
      const fetched = await gatewayClient.orders.getById({
        token: buyer.token,
        orderId: order.id,
      });

      return fetched?.status === "complete" ? fetched : undefined;
    }, 10_000);
    expect(completed.status).toBe("complete");
    expect(completed.version).toBe(2);
  }, 90_000);
});

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "NOT_FOUND";
}
