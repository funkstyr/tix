import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient, type RouterClient } from "@orpc/server";
import type { AuthRouter } from "auth/router";

type AuthRouterClient = RouterClient<AuthRouter>;

export type AuthSession = NonNullable<Awaited<ReturnType<AuthRouterClient["getSession"]>>>;

export type AuthSessionClient = {
  getSession: (input: { token: string }) => Promise<AuthSession | null>;
};

export function createHttpAuthSessionClient(authBaseUrl: string): AuthSessionClient {
  const link = new RPCLink({ url: `${authBaseUrl.replace(/\/$/, "")}/rpc` });
  const client: AuthRouterClient = createORPCClient(link);

  return {
    getSession: (input) => client.getSession(input),
  };
}

export function createInProcessAuthSessionClient(authRouter: AuthRouter): AuthSessionClient {
  const client: AuthRouterClient = createRouterClient(authRouter);

  return {
    getSession: (input) => client.getSession(input),
  };
}
