import { redirect } from "@tanstack/react-router";

import type { AuthContextValue } from "./auth-context";

// Use this in a route's `beforeLoad` to gate access. The root route awaits
// `ensureLoaded` so `currentUser` is settled by the time this runs.
export function requireAuth(auth: AuthContextValue, redirectHref: string): void {
  if (auth.currentUser !== null) return;

  throw redirect({
    to: "/auth/signin",
    search: { redirect: redirectHref },
  });
}
