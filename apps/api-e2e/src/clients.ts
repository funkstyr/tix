import { setTimeout as delay } from "node:timers/promises";

import { makeSagaClients } from "@tix/saga-client/clients";

import type { AuthRouterClient } from "@tix/contracts/auth";
import type { OrdersRouterClient } from "@tix/contracts/orders";
import type { TicketsRouterClient } from "@tix/contracts/tickets";

import { env } from "./env.ts";

// api-e2e drives each service on its own localhost port (no gateway) and never charges, so the
// shared factory is pointed at the per-service URLs; the payments client is unused here, so its
// base URL is a harmless placeholder (env has no PAYMENTS_BASE_URL).
const sagaClients = makeSagaClients({
  authBaseUrl: env.AUTH_BASE_URL,
  ticketsBaseUrl: env.TICKETS_BASE_URL,
  ordersBaseUrl: env.ORDERS_BASE_URL,
  paymentsBaseUrl: env.ORDERS_BASE_URL,
});

export function authClient(): AuthRouterClient {
  return sagaClients.auth;
}

export function ticketsClient(): TicketsRouterClient {
  return sagaClients.tickets;
}

export function ordersClient(): OrdersRouterClient {
  return sagaClients.orders;
}

export async function pollTicketRestored(
  client: TicketsRouterClient,
  ticketId: string,
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- polling is inherently sequential
    const t = await client.getById({ ticketId });
    if (t && t.quantityAvailable === expected) return;
    // eslint-disable-next-line no-await-in-loop -- backoff before the next poll
    await delay(250);
  }
  throw new Error(
    `ticket ${ticketId} did not restore to quantityAvailable=${expected} within ${timeoutMs}ms`,
  );
}
