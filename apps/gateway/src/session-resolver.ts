import type { CurrentUser } from "@tix/contracts/auth";
import type { AuthSessionClient } from "@tix/contracts/auth-client";

export type SessionResolverDeps = {
  authClient: AuthSessionClient;
  sessionCookieName: string;
};

export type ResolveSession = (req: Request) => Promise<CurrentUser | null>;

export function createSessionResolver(deps: SessionResolverDeps): ResolveSession {
  // Per-request memo: multiple middlewares / handlers can ask for the session
  // on the same Request; coalesce to a single auth round-trip.
  const cache = new WeakMap<Request, Promise<CurrentUser | null>>();

  return (req) => {
    const cached = cache.get(req);
    if (cached !== undefined) return cached;

    const promise = resolve(req, deps);
    cache.set(req, promise);

    return promise;
  };
}

async function resolve(req: Request, deps: SessionResolverDeps): Promise<CurrentUser | null> {
  const cookieHeader = req.headers.get("cookie");
  if (cookieHeader === null) return null;

  const token = readCookie(cookieHeader, deps.sessionCookieName);
  if (token === null) return null;

  const session = await deps.authClient.getSession({ token });
  if (session === null) return null;

  return session.user;
}

function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;

    const key = part.slice(0, eq).trim();
    if (key !== name) continue;

    const raw = part.slice(eq + 1).trim();
    if (raw === "") return null;

    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }

  return null;
}
