import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { setTimeout as delay } from "node:timers/promises";

import type { AuthRouterClient } from "@tix/contracts/auth";
import type { OrdersRouterClient } from "@tix/contracts/orders";
import { RPC_PREFIX } from "@tix/contracts/rpc";
import type { TicketsRouterClient } from "@tix/contracts/tickets";

import { env } from "./e2e-env.ts";

export function authClient(): AuthRouterClient {
  const link = new RPCLink({ url: `${env.AUTH_BASE_URL}${RPC_PREFIX}` });
  return createORPCClient(link);
}

export function ticketsClient(): TicketsRouterClient {
  const link = new RPCLink({ url: `${env.TICKETS_BASE_URL}${RPC_PREFIX}` });
  return createORPCClient(link);
}

export function ordersClient(): OrdersRouterClient {
  const link = new RPCLink({ url: `${env.ORDERS_BASE_URL}${RPC_PREFIX}` });
  return createORPCClient(link);
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
