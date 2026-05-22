import type { OrdersRouterClient } from "./orders";
import type { PaymentsRouterClient } from "./payments";
import type { TicketsRouterClient } from "./tickets";

// Subset of TicketsRouterClient: the gateway only fronts the buyer/seller-facing
// procedures; `tickets.reserve` is internal to the orders reservation saga and
// must not be reachable from the browser.
export type GatewayRouterClient = {
  tickets: Pick<TicketsRouterClient, "create" | "getById" | "list">;
  orders: OrdersRouterClient;
  payments: PaymentsRouterClient;
};
