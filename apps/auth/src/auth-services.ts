import { Context, Effect, Layer } from "effect";

import { type DbClient } from "@tix/db-core/client";

import type { AuthEnv } from "./auth-env.ts";
import { type AuthInstance, createAuth } from "./auth-instance.ts";
import { authTables } from "./auth-schema.ts";

export type AuthDb = DbClient<typeof authTables>;

export class AuthConfig extends Context.Tag("auth/AuthConfig")<AuthConfig, AuthEnv>() {}

export class Database extends Context.Tag("auth/Database")<Database, AuthDb>() {}

export class Auth extends Context.Tag("auth/Auth")<Auth, AuthInstance>() {}

export function makeAuthConfigLayer(env: AuthEnv): Layer.Layer<AuthConfig> {
  return Layer.succeed(AuthConfig, env);
}

// The better-auth issuer is a pure construction over the drizzle client and config.
export const AuthLayer: Layer.Layer<Auth, never, AuthConfig | Database> = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const env = yield* AuthConfig;
    const db = yield* Database;

    return createAuth({ db: db.db, secret: env.secret, baseURL: env.baseURL });
  }),
);
