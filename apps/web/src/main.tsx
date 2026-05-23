import { type JSX, StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";

import { createWebAuthClient } from "./auth/auth-client";
import { AuthProvider } from "./auth/auth-context";
import { useAuth } from "./auth/use-auth";
import { ClientProvider } from "./client/client-context";
import { createGatewayClient } from "./client/gateway-client";
import { parseEnv } from "./env";
import type { RouterContext } from "./routes/__root";
import { routeTree } from "./routeTree.gen";

const env = parseEnv(import.meta.env);
const gatewayClient = createGatewayClient(env.VITE_GATEWAY_URL);
const authClient = createWebAuthClient(env.VITE_GATEWAY_URL);

const router = createRouter({
  routeTree,
  context: { auth: undefined } as unknown as RouterContext,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Root element #root not found");

createRoot(rootElement).render(
  <StrictMode>
    <ClientProvider client={gatewayClient}>
      <AuthProvider client={authClient}>
        <AppRouter />
      </AuthProvider>
    </ClientProvider>
  </StrictMode>,
);

function AppRouter(): JSX.Element {
  const auth = useAuth();
  const context = useMemo<RouterContext>(() => ({ auth }), [auth]);

  return <RouterProvider router={router} context={context} />;
}
