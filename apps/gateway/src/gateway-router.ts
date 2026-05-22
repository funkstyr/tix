import { os } from "@orpc/server";

import { ticketsListInput, ticketsListOutput } from "@tix/contracts/tickets";

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
