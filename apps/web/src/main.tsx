import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";

import { ClientProvider } from "./client/client-context";
import { createGatewayClient } from "./client/gateway-client";
import { parseEnv } from "./env";
import { routeTree } from "./routeTree.gen";

const env = parseEnv(import.meta.env);
const client = createGatewayClient(env.VITE_GATEWAY_URL);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Root element #root not found");

createRoot(rootElement).render(
  <StrictMode>
    <ClientProvider client={client}>
      <RouterProvider router={router} />
    </ClientProvider>
  </StrictMode>,
);
