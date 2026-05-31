import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { ORPCError } from "@orpc/server";

import type { AuthRouterClient, AuthSession } from "./auth";
import { RPC_PREFIX } from "./rpc";

export type AuthSessionClient = {
  getSession: (input: { token: string }) => Promise<AuthSession | null>;
};

// Optional per-request header hook; orders passes a trace-context injector so outbound
// auth calls carry W3C `traceparent` (ADR-0009). Kept as a plain function so `@tix/contracts`
// gains no observability dependency.
export type HttpClientOptions = {
  headers?: () => Record<string, string>;
};

export function createHttpAuthSessionClient(
  authBaseUrl: string,
  options: HttpClientOptions = {},
): AuthSessionClient {
  // Wrap in a zero-arg call: RPCLink invokes the `headers` function as
  // `headers(options, path, input)`, and the hook resolves its own carrier (the active
  // span) — it must not receive oRPC's options object as an argument.
  const headersHook = options.headers;
  const link = new RPCLink({
    url: `${authBaseUrl.replace(/\/$/, "")}${RPC_PREFIX}`,
    ...(headersHook === undefined ? {} : { headers: () => headersHook() }),
  });
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
