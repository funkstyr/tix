import { useContext } from "react";

import type { GatewayRouterClient } from "@tix/contracts/gateway";

import { ClientContext } from "./client-context";

export function useClient(): GatewayRouterClient {
  const client = useContext(ClientContext);
  if (client === null) {
    throw new Error("useClient must be called inside <ClientProvider>");
  }

  return client;
}
