import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import { RPC_PREFIX } from "@tix/contracts/rpc";
import type { ReserveTicketInput, ReserveTicketOutput } from "@tix/contracts/tickets-reserve";

export type TicketSnapshot = {
  id: string;
  sellerId: string;
  quantityAvailable: number;
  version: number;
};

export type TicketsClient = {
  reserve: (input: ReserveTicketInput) => Promise<ReserveTicketOutput>;
  getById: (input: { ticketId: string }) => Promise<TicketSnapshot | null>;
};

type TicketsRouterClient = {
  reserve: (input: ReserveTicketInput) => Promise<ReserveTicketOutput>;
  getById: (input: { ticketId: string }) => Promise<TicketSnapshot | null>;
};

export function createHttpTicketsClient(
  ticketsBaseUrl: string,
  serviceToken: string,
): TicketsClient {
  const link = new RPCLink({
    url: `${ticketsBaseUrl.replace(/\/$/, "")}${RPC_PREFIX}`,
    headers: { "x-service-token": serviceToken },
  });
  const client: TicketsRouterClient = createORPCClient(link);

  return {
    reserve: (input) => client.reserve(input),
    getById: (input) => client.getById(input),
  };
}

export function createInProcessTicketsClient(client: TicketsRouterClient): TicketsClient {
  return {
    reserve: (input) => client.reserve(input),
    getById: (input) => client.getById(input),
  };
}
