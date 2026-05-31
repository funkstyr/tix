import { Context, Effect, Layer } from "effect";

import { createDbClient, type DbClient } from "@tix/db-core/client";

import type { AuthEnv } from "./auth-env.ts";
import { type AuthInstance, createAuth } from "./auth-instance.ts";
import { authTables } from "./auth-schema.ts";

export type AuthDb = DbClient<typeof authTables>;

// Service tags. Together these replace the hand-injected `deps` object — the router
// resolves `Auth` from the runtime's Layer graph instead of receiving it as a
// constructor argument (ADR-0008). `AuthConfig` and `Database` stay internal: they
// only exist to build `Auth` and to give the connection a scoped lifecycle.
export class AuthConfig extends Context.Tag("auth/AuthConfig")<AuthConfig, AuthEnv>() {}

export class Database extends Context.Tag("auth/Database")<Database, AuthDb>() {}

export class Auth extends Context.Tag("auth/Auth")<Auth, AuthInstance>() {}

export function makeAuthConfigLayer(env: AuthEnv): Layer.Layer<AuthConfig> {
  return Layer.succeed(AuthConfig, env);
}

// The db client connects lazily, so acquisition is synchronous; release drains the
// pool. Scope finalization tears it down automatically (LIFO) at shutdown.
export const DatabaseLayer: Layer.Layer<Database, never, AuthConfig> = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const env = yield* AuthConfig;

    return yield* Effect.acquireRelease(
      Effect.sync(() => createDbClient("auth", env.databaseUrl, { schema: authTables })),
      (client) => Effect.promise(() => client.close()),
    );
  }),
);

// The better-auth issuer is a pure construction over the drizzle client and config.
export const AuthLayer: Layer.Layer<Auth, never, AuthConfig | Database> = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const env = yield* AuthConfig;
    const db = yield* Database;

    return createAuth({ db: db.db, secret: env.secret, baseURL: env.baseURL });
  }),
);
