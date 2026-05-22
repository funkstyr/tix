import { os } from "@orpc/server";

import type { CurrentUser } from "@tix/contracts/auth";
import { ticketsListInput, ticketsListOutput } from "@tix/contracts/tickets";

import type { DownstreamClients } from "./downstream-clients.ts";

export type GatewayInitialContext = {
  request: Request;
  cookieHeader: string | null;
};

export type GetCurrentUser = (req: Request) => Promise<CurrentUser | null>;

export type GatewayRouterDeps = {
  clients: DownstreamClients;
  getCurrentUser: GetCurrentUser;
};

export function createGatewayRouter(deps: GatewayRouterDeps) {
  const { clients, getCurrentUser } = deps;

  const base = os.$context<GatewayInitialContext>().use(async ({ context, next }) => {
    const currentUser = await getCurrentUser(context.request);
    return next({ context: { currentUser } });
  });

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
