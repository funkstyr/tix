import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import type { AuthRouterClient } from "@tix/contracts/auth";
import type { OrdersRouterClient } from "@tix/contracts/orders";
import type { PaymentsRouterClient } from "@tix/contracts/payments";
import { joinRpcUrl } from "@tix/contracts/rpc";
import type { TicketsRouterClient } from "@tix/contracts/tickets";

// One typed oRPC client per router, each pointed at an explicit base URL so the same flow runs
// against api-e2e child processes (per-service localhost ports) OR a live gateway URL.
export type SagaClients = {
  auth: AuthRouterClient;
  tickets: TicketsRouterClient;
  orders: OrdersRouterClient;
  payments: PaymentsRouterClient;
};

export type SagaClientUrls = {
  authBaseUrl: string;
  ticketsBaseUrl: string;
  ordersBaseUrl: string;
  paymentsBaseUrl: string;
};

// One auth client on its own. The synthetic seed only needs auth (sign-in/sign-up), so it builds
// just this rather than the full saga set — and makeSagaClients reuses it to stay DRY.
export function makeAuthClient(authBaseUrl: string): AuthRouterClient {
  return createORPCClient(new RPCLink({ url: joinRpcUrl(authBaseUrl) }));
}

export function makeSagaClients(urls: SagaClientUrls): SagaClients {
  const auth = makeAuthClient(urls.authBaseUrl);
  const tickets: TicketsRouterClient = createORPCClient(
    new RPCLink({ url: joinRpcUrl(urls.ticketsBaseUrl) }),
  );
  const orders: OrdersRouterClient = createORPCClient(
    new RPCLink({ url: joinRpcUrl(urls.ordersBaseUrl) }),
  );
  const payments: PaymentsRouterClient = createORPCClient(
    new RPCLink({ url: joinRpcUrl(urls.paymentsBaseUrl) }),
  );

  return { auth, tickets, orders, payments };
}
