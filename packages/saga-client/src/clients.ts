import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import type { AuthRouterClient } from "@tix/contracts/auth";
import type { OrdersRouterClient } from "@tix/contracts/orders";
import type { PaymentsRouterClient } from "@tix/contracts/payments";
import { RPC_PREFIX } from "@tix/contracts/rpc";
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

export function makeSagaClients(urls: SagaClientUrls): SagaClients {
  const auth: AuthRouterClient = createORPCClient(
    new RPCLink({ url: `${urls.authBaseUrl}${RPC_PREFIX}` }),
  );
  const tickets: TicketsRouterClient = createORPCClient(
    new RPCLink({ url: `${urls.ticketsBaseUrl}${RPC_PREFIX}` }),
  );
  const orders: OrdersRouterClient = createORPCClient(
    new RPCLink({ url: `${urls.ordersBaseUrl}${RPC_PREFIX}` }),
  );
  const payments: PaymentsRouterClient = createORPCClient(
    new RPCLink({ url: `${urls.paymentsBaseUrl}${RPC_PREFIX}` }),
  );

  return { auth, tickets, orders, payments };
}
