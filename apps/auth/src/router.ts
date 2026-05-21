import { os } from "@orpc/server";
import { type } from "arktype";

import { rethrowAsOrpc } from "./auth-errors.ts";
import type { AuthInstance } from "./auth-instance.ts";

const signUpInput = type({
  email: "string.email",
  password: "string >= 8",
  name: "string >= 1",
});

const signInInput = type({
  email: "string.email",
  password: "string >= 1",
});

const tokenInput = type({
  token: "string >= 1",
});

const credentialsOutput = type({
  userId: "string",
  email: "string.email",
  token: "string",
});

const okOutput = type({
  ok: "true",
});

const sessionOutput = type({
  "+": "delete",
  user: { id: "string", email: "string.email", name: "string" },
  session: { id: "string", expiresAt: "string" },
}).or("null");

function bearerHeaders(token: string): Headers {
  return new Headers({ authorization: `Bearer ${token}` });
}

export type AuthRouterDeps = {
  auth: AuthInstance;
};

export function createAuthRouter(deps: AuthRouterDeps) {
  const { auth } = deps;

  const signUp = os
    .input(signUpInput)
    .output(credentialsOutput)
    .handler(async ({ input }) => {
      try {
        const result = await auth.api.signUpEmail({ body: input });
        if (result.token === null) {
          throw new Error("sign-up did not return a session token");
        }

        return { userId: result.user.id, email: result.user.email, token: result.token };
      } catch (error) {
        rethrowAsOrpc(error);
      }
    });

  const signIn = os
    .input(signInInput)
    .output(credentialsOutput)
    .handler(async ({ input }) => {
      try {
        const result = await auth.api.signInEmail({ body: input });

        return { userId: result.user.id, email: result.user.email, token: result.token };
      } catch (error) {
        rethrowAsOrpc(error);
      }
    });

  const signOut = os
    .input(tokenInput)
    .output(okOutput)
    .handler(async ({ input }) => {
      try {
        await auth.api.signOut({ headers: bearerHeaders(input.token) });

        return { ok: true as const };
      } catch (error) {
        rethrowAsOrpc(error);
      }
    });

  const getSession = os
    .input(tokenInput)
    .output(sessionOutput)
    .handler(async ({ input }) => {
      try {
        const result = await auth.api.getSession({ headers: bearerHeaders(input.token) });
        if (result === null) return null;

        return {
          user: { id: result.user.id, email: result.user.email, name: result.user.name },
          session: { id: result.session.id, expiresAt: result.session.expiresAt.toISOString() },
        };
      } catch (error) {
        rethrowAsOrpc(error);
      }
    });

  return { signUp, signIn, signOut, getSession };
}

export type AuthRouter = ReturnType<typeof createAuthRouter>;
