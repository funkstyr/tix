import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import type { AuthRouterClient } from "@tix/contracts/auth";
import type { OrdersRouterClient } from "@tix/contracts/orders";
import type { PaymentsRouterClient } from "@tix/contracts/payments";
import { joinRpcUrl } from "@tix/contracts/rpc";
import type { TicketsRouterClient } from "@tix/contracts/tickets";
import { traceparentHeaders } from "@tix/observability/otel-http";

export type CookieContext = { cookieHeader: string | null };

type CallOptions = { context: CookieContext };

export type DownstreamRouterClient<T> = {
  [K in keyof T]: T[K] extends (input: infer I) => infer R
    ? (input: I, options: CallOptions) => R
    : never;
};

type DroppedMethods<T> = {
  [K in keyof T]: T[K] extends (input: never) => unknown
    ? T[K] extends () => unknown
      ? K
      : never
    : K;
}[keyof T];

// If a router method isn't a single-input function (e.g. `() => Promise<T>`,
// or two required args), its key surfaces in `DroppedMethods<T>` and the
// wrapped client collapses to a sentinel — any call against it then fails to
// compile, turning a silent shape drift into a type error.
type CheckedDownstream<T> = [DroppedMethods<T>] extends [never]
  ? DownstreamRouterClient<T>
  : { __unsupported_router_method_shape__: DroppedMethods<T> };

export type DownstreamClients = {
  tickets: CheckedDownstream<TicketsRouterClient>;
  orders: CheckedDownstream<OrdersRouterClient>;
  payments: CheckedDownstream<PaymentsRouterClient>;
  auth: CheckedDownstream<AuthRouterClient>;
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
  // Resolve headers per request so the trace-context injector sees the active span;
  // `traceparentHeaders()` is `{}` when no span is active, so the cookie logic is
  // unchanged in that case.
  const link = new RPCLink<CookieContext>({
    url: joinRpcUrl(baseUrl),
    headers: ({ context }) => ({
      ...traceparentHeaders(),
      ...(context.cookieHeader === null ? {} : { cookie: context.cookieHeader }),
    }),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  return createORPCClient(link) as unknown as DownstreamRouterClient<T>;
}
