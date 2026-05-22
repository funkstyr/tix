import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import type { AuthRouterClient } from "@tix/contracts/auth";
import type { OrdersRouterClient } from "@tix/contracts/orders";
import type { PaymentsRouterClient } from "@tix/contracts/payments";
import { RPC_PREFIX } from "@tix/contracts/rpc";
import type { TicketsRouterClient } from "@tix/contracts/tickets";

export type CookieContext = { cookieHeader: string | null };

type CallOptions = { context: CookieContext };

export type DownstreamRouterClient<T> = {
  [K in keyof T]: T[K] extends (input: infer I) => infer R
    ? (input: I, options: CallOptions) => R
    : never;
};

export type DownstreamClients = {
  tickets: DownstreamRouterClient<TicketsRouterClient>;
  orders: DownstreamRouterClient<OrdersRouterClient>;
  payments: DownstreamRouterClient<PaymentsRouterClient>;
  auth: DownstreamRouterClient<AuthRouterClient>;
};

export type DownstreamServiceUrls = {
  ticketsBaseUrl: string;
  ordersBaseUrl: string;
  paymentsBaseUrl: string;
  authBaseUrl: string;
};

export type CreateDownstreamClientsOptions = {
  fetch?: typeof globalThis.fetch;
};

export function createDownstreamClients(
  urls: DownstreamServiceUrls,
  options: CreateDownstreamClientsOptions = {},
): DownstreamClients {
  return {
    tickets: makeClient<TicketsRouterClient>(urls.ticketsBaseUrl, options.fetch),
    orders: makeClient<OrdersRouterClient>(urls.ordersBaseUrl, options.fetch),
    payments: makeClient<PaymentsRouterClient>(urls.paymentsBaseUrl, options.fetch),
    auth: makeClient<AuthRouterClient>(urls.authBaseUrl, options.fetch),
  };
}

function makeClient<T>(
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch | undefined,
): DownstreamRouterClient<T> {
  const link = new RPCLink<CookieContext>({
    url: `${baseUrl.replace(/\/$/, "")}${RPC_PREFIX}`,
    headers: ({ context }) =>
      context.cookieHeader === null ? {} : { cookie: context.cookieHeader },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  return createORPCClient(link) as unknown as DownstreamRouterClient<T>;
}
