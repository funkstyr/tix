import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import type { GatewayRouterClient } from "@tix/contracts/gateway";
import { joinRpcUrl } from "@tix/contracts/rpc";

// `credentials: "include"` is set per-request rather than via a global default
// so this client behaves the same whether the host page is same-origin or
// cross-origin with the gateway — cookies always flow.
export function createGatewayClient(gatewayUrl: string): GatewayRouterClient {
  const link = new RPCLink({
    url: joinRpcUrl(gatewayUrl),
    fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
  });

  return createORPCClient(link);
}
