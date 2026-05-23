import { type } from "arktype";

// URL prefix at which the gateway exposes the auth service. Shared so the web
// client and the gateway proxy agree on the same path without drifting.
export const AUTH_PROXY_PREFIX = "/api/auth";

export const signUpInput = type({
  email: "string.email",
  password: "string >= 8",
  name: "string >= 1",
});
export type SignUpInput = typeof signUpInput.infer;

export const signInInput = type({
  email: "string.email",
  password: "string >= 1",
});
export type SignInInput = typeof signInInput.infer;

export const tokenInput = type({
  token: "string >= 1",
});
export type TokenInput = typeof tokenInput.infer;

export const credentialsOutput = type({
  userId: "string",
  email: "string.email",
  token: "string",
});
export type Credentials = typeof credentialsOutput.infer;

export const okOutput = type({
  ok: "true",
});
export type Ok = typeof okOutput.infer;

export const currentUser = type({
  id: "string",
  email: "string.email",
  name: "string",
});
export type CurrentUser = typeof currentUser.infer;

export const sessionOutput = type({
  "+": "delete",
  user: currentUser,
  session: { id: "string", expiresAt: "string" },
}).or("null");
export type SessionResult = typeof sessionOutput.infer;
export type AuthSession = Exclude<SessionResult, null>;

export type AuthRouterClient = {
  signUp: (input: SignUpInput) => Promise<Credentials>;
  signIn: (input: SignInInput) => Promise<Credentials>;
  signOut: (input: TokenInput) => Promise<Ok>;
  getSession: (input: TokenInput) => Promise<AuthSession | null>;
};
