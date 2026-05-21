import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { ORPCError } from "@orpc/server";

import type { AuthRouterClient, AuthSession } from "./auth";
import { RPC_PREFIX } from "./rpc";

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

export async function requireSession(
  authClient: AuthSessionClient,
  token: string,
): Promise<AuthSession> {
  const session = await authClient.getSession({ token });
  if (session === null) {
    throw new ORPCError("UNAUTHORIZED", { message: "invalid or expired session" });
  }

  return session;
}
