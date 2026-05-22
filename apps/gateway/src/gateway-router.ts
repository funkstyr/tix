import { os } from "@orpc/server";

import {
  ticketCreateInput,
  ticketGetByIdInput,
  ticketRecordOrNullOutput,
  ticketRecordOutput,
  ticketsListInput,
  ticketsListOutput,
} from "@tix/contracts/tickets";
import { reserveTicketInput, reserveTicketOutput } from "@tix/contracts/tickets-reserve";

import type { DownstreamClients } from "./downstream-clients.ts";

export type GatewayInitialContext = {
  cookieHeader: string | null;
};

export type GatewayRouterDeps = {
  clients: DownstreamClients;
};

export function createGatewayRouter(deps: GatewayRouterDeps) {
  const { clients } = deps;
  const base = os.$context<GatewayInitialContext>();

  const tickets = {
    create: base
      .input(ticketCreateInput)
      .output(ticketRecordOutput)
      .handler(async ({ input, context }) => {
        return await clients.tickets.create(input, {
          context: { cookieHeader: context.cookieHeader },
        });
      }),
    reserve: base
      .input(reserveTicketInput)
      .output(reserveTicketOutput)
      .handler(async ({ input, context }) => {
        return await clients.tickets.reserve(input, {
          context: { cookieHeader: context.cookieHeader },
        });
      }),
    getById: base
      .input(ticketGetByIdInput)
      .output(ticketRecordOrNullOutput)
      .handler(async ({ input, context }) => {
        return await clients.tickets.getById(input, {
          context: { cookieHeader: context.cookieHeader },
        });
      }),
    list: base
      .input(ticketsListInput)
      .output(ticketsListOutput)
      .handler(async ({ input, context }) => {
        return await clients.tickets.list(input, {
          context: { cookieHeader: context.cookieHeader },
        });
      }),
  };

  return { tickets };
}

export type GatewayRouter = ReturnType<typeof createGatewayRouter>;
