import { createAuthClient } from "better-auth/react";

import { AUTH_PROXY_PATH } from "./auth-proxy-path";

export type WebAuthClient = ReturnType<typeof createAuthClient>;

// Points the better-auth React client at the gateway's auth proxy, which
// forwards to the auth service. `credentials: "include"` is required so the
// session cookie flows on every call regardless of same-/cross-origin.
export function createWebAuthClient(gatewayUrl: string): WebAuthClient {
  const baseURL = `${gatewayUrl.replace(/\/$/, "")}${AUTH_PROXY_PATH}`;

  return createAuthClient({
    baseURL,
    fetchOptions: {
      credentials: "include",
    },
  });
}
