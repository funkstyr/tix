import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import type { AuthRouterClient, AuthSession } from "@tix/contracts/auth";
import { RPC_PREFIX } from "@tix/contracts/rpc";

export type { AuthSession };

export type AuthSessionClient = {
  getSession: (input: { token: string }) => Promise<AuthSession | null>;
};

export function createHttpAuthSessionClient(authBaseUrl: string): AuthSessionClient {
  const link = new RPCLink({ url: `${authBaseUrl.replace(/\/$/, "")}${RPC_PREFIX}` });
  const client: AuthRouterClient = createORPCClient(link);

  return {
    getSession: (input) => client.getSession(input),
  };
}

export function createInProcessAuthSessionClient(client: AuthRouterClient): AuthSessionClient {
  return {
    getSession: (input) => client.getSession(input),
  };
}
