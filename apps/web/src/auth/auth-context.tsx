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

  const loadPromiseRef = useRef<Promise<void> | null>(null);

  if (loadPromiseRef.current === null) {
    loadPromiseRef.current = client
      .getSession()
      .then((result) => {
        setCurrentUser(toCurrentUser(result.data?.user));
      })
      .catch(() => {
        setCurrentUser(null);
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

      return { error: null };
    },
    [client],
  );

  const signUp = useCallback(
    async (input: SignUpInput): Promise<AuthResult> => {
      const result = await client.signUp.email(input);
      if (result.error) return { error: result.error.message ?? "sign-up failed" };
      setCurrentUser(toCurrentUser(result.data.user));

      return { error: null };
    },
    [client],
  );

  const signOut = useCallback(async (): Promise<AuthResult> => {
    const result = await client.signOut();
    if (result.error) return { error: result.error.message ?? "sign-out failed" };
    setCurrentUser(null);

    return { error: null };
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({ currentUser, ensureLoaded, signIn, signUp, signOut }),
    [currentUser, ensureLoaded, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function toCurrentUser(
  user: { id: string; email: string; name: string } | undefined | null,
): CurrentUser | null {
  if (!user) return null;

  return { id: user.id, email: user.email, name: user.name };
}
