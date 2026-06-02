import { Layer } from "effect";

import { type DbClient } from "@tix/db-core/client";
import { makeServiceTestRuntime } from "@tix/service-runtime/test";

import type { AuthEnv } from "./auth-env.ts";
import type { AuthInstance } from "./auth-instance.ts";
import type { AuthRuntime } from "./auth-runtime.ts";
import type { authTables } from "./auth-schema.ts";
import { Auth, AuthConfig, type AuthDb, Database } from "./auth-services.ts";

export type AuthTestDeps = {
  auth: AuthInstance;
  // Optional real db client (with a live `sql`) so tests that exercise the readiness probe
  // can pass one; omitted by default since most in-process tests only drive the router.
  db?: AuthDb;
};

// Throwing stubs for the collaborators the runtime now surfaces (AuthConfig, Database) but
// that a router-only test doesn't supply — an accidental dependency surfaces loudly instead
// of silently using a half-built runtime (mirrors `@tix/service-runtime/test`).
function throwingDb(): AuthDb {
  return new Proxy({} as DbClient<typeof authTables>, {
    get() {
      throw new Error("Database not provided to auth test runtime");
    },
  });
}

function throwingConfig(): AuthEnv {
  return new Proxy({} as AuthEnv, {
    get() {
      throw new Error("AuthConfig not provided to auth test runtime");
    },
  });
}

// Builds a ManagedRuntime from an already-constructed better-auth instance instead of the
// env-driven layer, so in-process tests and the `@tix/auth-test-fixture` boot path drive the
// same Effect programs the router runs in production. OTLP is omitted. The runtime surfaces
// `Auth`, `AuthConfig`, and `Database` to match `AuthRuntime`; the latter two default to
// throwing stubs when the test doesn't supply them.
export function createAuthTestRuntime(deps: AuthTestDeps): AuthRuntime {
  return makeServiceTestRuntime(
    Layer.mergeAll(
      Layer.succeed(Auth, deps.auth),
      Layer.succeed(AuthConfig, throwingConfig()),
      Layer.succeed(Database, deps.db ?? throwingDb()),
    ),
  );
}
