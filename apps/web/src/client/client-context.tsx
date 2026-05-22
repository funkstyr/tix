import { createContext, type JSX, type ReactNode } from "react";

import type { GatewayRouterClient } from "@tix/contracts/gateway";

export const ClientContext = createContext<GatewayRouterClient | null>(null);

export function ClientProvider({
  client,
  children,
}: {
  client: GatewayRouterClient;
  children: ReactNode;
}): JSX.Element {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}
