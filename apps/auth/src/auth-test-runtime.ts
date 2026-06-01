import { Layer } from "effect";

import { makeServiceTestRuntime } from "@tix/service-runtime/test";

import type { AuthInstance } from "./auth-instance.ts";
import type { AuthRuntime } from "./auth-runtime.ts";
import { Auth } from "./auth-services.ts";

export type AuthTestDeps = {
  auth: AuthInstance;
};

// Builds a ManagedRuntime from an already-constructed better-auth instance instead of the
// env-driven layer, so in-process tests and the `@tix/auth-test-fixture` boot path drive the
// same Effect programs the router runs in production. OTLP is omitted.
export function createAuthTestRuntime(deps: AuthTestDeps): AuthRuntime {
  return makeServiceTestRuntime(Layer.succeed(Auth, deps.auth));
}
