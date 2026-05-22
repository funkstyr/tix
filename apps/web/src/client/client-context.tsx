import { createContext, type JSX, type ReactNode, useContext } from "react";

import type { GatewayRouterClient } from "@tix/contracts/gateway";

const ClientContext = createContext<GatewayRouterClient | null>(null);

export function ClientProvider({
  client,
  children,
}: {
  client: GatewayRouterClient;
  children: ReactNode;
}): JSX.Element {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useClient(): GatewayRouterClient {
  const client = useContext(ClientContext);
  if (client === null) {
    throw new Error("useClient must be called inside <ClientProvider>");
  }

  return client;
}
