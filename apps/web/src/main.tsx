import { type JSX, StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";

// eslint-disable-next-line import/no-unassigned-import -- side-effect CSS import (theme)
import "@tix/core-ui/styles.css";
import { initWebRum, setRumRoute } from "@tix/observability/web-rum";

import { createWebAuthClient } from "./auth/auth-client";
import { AuthProvider } from "./auth/auth-context";
import { useAuth } from "./auth/use-auth";
import { ClientProvider } from "./client/client-context";
import { createGatewayClient } from "./client/gateway-client";
import { parseEnv } from "./env";
import { rumConfigFromEnv } from "./observability/rum";
import type { RouterContext } from "./routes/__root";
import { routeTree } from "./routeTree.gen";

const env = parseEnv(import.meta.env);

// Browser RUM (ADR-0013). No-op when VITE_RUM_URL is unset. Initialized before the gateway
// client so the OTel-web fetch instrumentation patches `fetch` ahead of the first request,
// which is what threads `traceparent` onto the backend trace (the stitch).
const rumConfig = rumConfigFromEnv(env);
const faro = rumConfig ? initWebRum(rumConfig) : null;

const gatewayClient = createGatewayClient(env.VITE_GATEWAY_URL);
const authClient = createWebAuthClient(env.VITE_GATEWAY_URL);

// The router needs a context type at construction time, but the real auth
// value is provided per-render by <RouterProvider context={...}> in
// <AppRouter/> below. The cast satisfies the type checker without paying for
// a default value that would never be read.
const router = createRouter({
  routeTree,
  context: { auth: undefined } as unknown as RouterContext,
});

// Feed the normalized route PATTERN (e.g. /tickets/$ticketId), never the concrete path, as the
// RUM view label — the cardinality rule (ADR-0013). `routeId` is the pattern from the route tree.
if (faro) {
  router.subscribe("onResolved", () => {
    const match = router.state.matches.at(-1);
    if (match) setRumRoute(faro, match.routeId);
  });
}

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
  const context = useMemo<RouterContext>(() => ({ auth, gateway: gatewayClient }), [auth]);

  return <RouterProvider router={router} context={context} />;
}
