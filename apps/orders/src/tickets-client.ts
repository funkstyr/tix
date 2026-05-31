import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import { RPC_PREFIX } from "@tix/contracts/rpc";
import type { TicketSnapshot } from "@tix/contracts/tickets";
import type { ReserveTicketInput, ReserveTicketOutput } from "@tix/contracts/tickets-reserve";

export type { TicketSnapshot };

export type TicketsClient = {
  reserve: (input: ReserveTicketInput) => Promise<ReserveTicketOutput>;
  getById: (input: { ticketId: string }) => Promise<TicketSnapshot | null>;
};

export type TicketsClientOptions = {
  headers?: () => Record<string, string>;
};

export function createHttpTicketsClient(
  ticketsBaseUrl: string,
  serviceToken: string,
  options: TicketsClientOptions = {},
): TicketsClient {
  // Resolve headers per request so the optional trace-context injector sees the active
  // span; the static service token always rides along (ADR-0009).
  const link = new RPCLink({
    url: `${ticketsBaseUrl.replace(/\/$/, "")}${RPC_PREFIX}`,
    headers: () => ({ "x-service-token": serviceToken, ...options.headers?.() }),
  });
  const client: TicketsClient = createORPCClient(link);

  return {
    reserve: (input) => client.reserve(input),
    getById: (input) => client.getById(input),
  };
}

export function createInProcessTicketsClient(client: TicketsClient): TicketsClient {
  return {
    reserve: (input) => client.reserve(input),
    getById: (input) => client.getById(input),
  };
}
