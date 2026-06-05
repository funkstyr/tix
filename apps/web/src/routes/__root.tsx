import { type JSX } from "react";
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";

import type { GatewayRouterClient } from "@tix/contracts/gateway";
import { Spinner } from "@tix/core-ui/spinner";

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
    <div className="flex min-h-dvh flex-col">
      <Header />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Outlet />
      </main>

      <footer className="border-t py-6 text-center text-sm text-muted-foreground">
        tix — peer-to-peer ticket resale
      </footer>
    </div>
  );
}

function Header(): JSX.Element {
  const auth = useAuth();

  return (
    <header className="border-b">
      <nav className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <Link to="/" className="text-lg font-semibold tracking-tight">
          tix
        </Link>

        <div className="flex items-center gap-4 text-sm">
          <Link to="/tickets" className="text-muted-foreground hover:text-foreground">
            Browse
          </Link>

          {auth.currentUser === null ? (
            <>
              <Link to="/auth/signin" className="text-muted-foreground hover:text-foreground">
                Sign in
              </Link>

              <Link
                to="/auth/signup"
                className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90"
              >
                Sign up
              </Link>
            </>
          ) : (
            <>
              <Link to="/tickets/new" className="text-muted-foreground hover:text-foreground">
                List a ticket
              </Link>

              <Link to="/tickets/mine" className="text-muted-foreground hover:text-foreground">
                My tickets
              </Link>

              <Link to="/orders" className="text-muted-foreground hover:text-foreground">
                My orders
              </Link>

              <span data-testid="current-user" className="text-muted-foreground">
                {auth.currentUser.email}
              </span>

              <Link to="/auth/signout" className="text-muted-foreground hover:text-foreground">
                Sign out
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}

function PendingScreen(): JSX.Element {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner label="Loading" />
    </div>
  );
}
