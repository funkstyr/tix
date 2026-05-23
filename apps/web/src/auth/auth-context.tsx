import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

import type { CurrentUser, SignInInput, SignUpInput } from "@tix/contracts/auth";

import type { WebAuthClient } from "./auth-client";

export type AuthResult = { error: string | null };

export type AuthContextValue = {
  currentUser: CurrentUser | null;
  sessionToken: string | null;
  ensureLoaded: () => Promise<void>;
  signIn: (input: SignInInput) => Promise<AuthResult>;
  signUp: (input: SignUpInput) => Promise<AuthResult>;
  signOut: () => Promise<AuthResult>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export type AuthProviderProps = {
  client: WebAuthClient;
  children: ReactNode;
};

export function AuthProvider({ client, children }: AuthProviderProps): JSX.Element {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);

  const [sessionToken, setSessionToken] = useState<string | null>(null);

  const loadPromiseRef = useRef<Promise<void> | null>(null);

  if (loadPromiseRef.current === null) {
    loadPromiseRef.current = client
      .getSession()
      .then((result) => {
        setCurrentUser(toCurrentUser(result.data?.user));
        setSessionToken(toSessionToken(result.data?.session));
      })
      .catch(() => {
        setCurrentUser(null);
        setSessionToken(null);
      });
  }

  const ensureLoaded = useCallback(async () => {
    await loadPromiseRef.current;
  }, []);

  const signIn = useCallback(
    async (input: SignInInput): Promise<AuthResult> => {
      const result = await client.signIn.email(input);
      if (result.error) return { error: result.error.message ?? "sign-in failed" };
      setCurrentUser(toCurrentUser(result.data.user));
      setSessionToken(toSessionToken(result.data));

      return { error: null };
    },
    [client],
  );

  const signUp = useCallback(
    async (input: SignUpInput): Promise<AuthResult> => {
      const result = await client.signUp.email(input);
      if (result.error) return { error: result.error.message ?? "sign-up failed" };
      setCurrentUser(toCurrentUser(result.data.user));
      setSessionToken(toSessionToken(result.data));

      return { error: null };
    },
    [client],
  );

  const signOut = useCallback(async (): Promise<AuthResult> => {
    const result = await client.signOut();
    if (result.error) return { error: result.error.message ?? "sign-out failed" };
    setCurrentUser(null);
    setSessionToken(null);

    return { error: null };
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({ currentUser, sessionToken, ensureLoaded, signIn, signUp, signOut }),
    [currentUser, sessionToken, ensureLoaded, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function toCurrentUser(
  user: { id: string; email: string; name: string } | undefined | null,
): CurrentUser | null {
  if (!user) return null;

  return { id: user.id, email: user.email, name: user.name };
}

// Callers pass whichever level of the better-auth response carries the token:
// `result.data?.session` from getSession, or `result.data` from signIn / signUp.
function toSessionToken(source: { token?: string | null } | undefined | null): string | null {
  const token = source?.token;
  if (typeof token !== "string" || token.length === 0) return null;

  return token;
}
