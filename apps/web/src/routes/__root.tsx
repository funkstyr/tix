import { type JSX } from "react";
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";

import type { GatewayRouterClient } from "@tix/contracts/gateway";

import type { AuthContextValue } from "../auth/auth-context";
import { useAuth } from "../auth/use-auth";

export type RouterContext = {
  auth: AuthContextValue;
  gateway: GatewayRouterClient;
};

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context }) => {
    await context.auth.ensureLoaded();
  },
  component: RootLayout,
  pendingComponent: PendingScreen,
});

function RootLayout(): JSX.Element {
  return (
    <>
      <Header />
      <main>
        <Outlet />
      </main>
    </>
  );
}

function Header(): JSX.Element {
  const auth = useAuth();

  return (
    <header>
      <nav>
        <Link to="/">tix</Link>
        {auth.currentUser === null ? (
          <>
            <Link to="/auth/signin">Sign in</Link>
            <Link to="/auth/signup">Sign up</Link>
          </>
        ) : (
          <>
            <span data-testid="current-user">{auth.currentUser.email}</span>
            <Link to="/auth/signout">Sign out</Link>
          </>
        )}
      </nav>
    </header>
  );
}

function PendingScreen(): JSX.Element {
  return <p>Loading…</p>;
}
