import { os } from "@orpc/server";

import {
  orderCancelInput,
  orderCancelOutput,
  orderCreateInput,
  orderGetByIdInput,
  orderRecordOrNullOutput,
  orderRecordOutput,
  ordersListInput,
  ordersListOutput,
} from "@tix/contracts/orders";
import { paymentCreateInput, paymentCreateOutput } from "@tix/contracts/payments";
import {
  ticketCreateInput,
  ticketGetByIdInput,
  ticketRecordOrNullOutput,
  ticketRecordOutput,
  ticketsListInput,
  ticketsListMineInput,
  ticketsListOutput,
} from "@tix/contracts/tickets";

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
    listMine: base
      .input(ticketsListMineInput)
      .output(ticketsListOutput)
      .handler(async ({ input, context }) => {
        return await clients.tickets.listMine(input, {
          context: { cookieHeader: context.cookieHeader },
        });
      }),
  };

  const orders = {
    create: base
      .input(orderCreateInput)
      .output(orderRecordOutput)
      .handler(async ({ input, context }) => {
        return await clients.orders.create(input, {
          context: { cookieHeader: context.cookieHeader },
        });
      }),
    getById: base
      .input(orderGetByIdInput)
      .output(orderRecordOrNullOutput)
      .handler(async ({ input, context }) => {
        return await clients.orders.getById(input, {
          context: { cookieHeader: context.cookieHeader },
        });
      }),
    list: base
      .input(ordersListInput)
      .output(ordersListOutput)
      .handler(async ({ input, context }) => {
        return await clients.orders.list(input, {
          context: { cookieHeader: context.cookieHeader },
        });
      }),
    cancel: base
      .input(orderCancelInput)
      .output(orderCancelOutput)
      .handler(async ({ input, context }) => {
        return await clients.orders.cancel(input, {
          context: { cookieHeader: context.cookieHeader },
        });
      }),
  };

  const payments = {
    create: base
      .input(paymentCreateInput)
      .output(paymentCreateOutput)
      .handler(async ({ input, context }) => {
        return await clients.payments.create(input, {
          context: { cookieHeader: context.cookieHeader },
        });
      }),
  };

  return { tickets, orders, payments };
}

export type GatewayRouter = ReturnType<typeof createGatewayRouter>;
