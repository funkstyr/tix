import { redirect } from "@tanstack/react-router";

import type { AuthContextValue } from "./auth-context";

// Use this in a route's `beforeLoad` or `loader` to gate access. The root route
// awaits `ensureLoaded` so `currentUser` and `sessionToken` are settled by the
// time this runs. Returns the validated session token so loaders can call
// downstream services without a second null check.
export function requireAuth(auth: AuthContextValue, redirectHref: string): string {
  if (auth.currentUser !== null && auth.sessionToken !== null) {
    return auth.sessionToken;
  }

  throw redirect({
    to: "/auth/signin",
    search: { redirect: redirectHref },
  });
}
