import { Layer, type ManagedRuntime } from "effect";

import { makeDatabaseLayer } from "@tix/service-runtime/layers";
import { makeServiceRuntime } from "@tix/service-runtime/runtime";

import type { AuthEnv } from "./auth-env.ts";
import { authTables } from "./auth-schema.ts";
import { Auth, AuthConfig, AuthLayer, Database, makeAuthConfigLayer } from "./auth-services.ts";

// The runtime surfaces `Auth` plus the `Database` it's built from so the readiness probe
// (ADR-0011 Tier 1) can run a db check against the live pool. `AuthConfig` rides along too.
// The scoped `Database` finalizer (pool drain) runs at disposal because it's part of the
// runtime's scope.
export type AuthServices = Auth | AuthConfig | Database;
export type AuthRuntime = ManagedRuntime.ManagedRuntime<AuthServices, never>;

export function makeAuthLayer(env: AuthEnv): Layer.Layer<AuthServices> {
  const config = makeAuthConfigLayer(env);
  const database = makeDatabaseLayer(Database, {
    schemaName: "auth",
    databaseUrl: env.databaseUrl,
    schema: authTables,
  });
  return AuthLayer.pipe(Layer.provideMerge(Layer.merge(config, database)));
}

export function makeAuthRuntime(env: AuthEnv): AuthRuntime {
  return makeServiceRuntime({
    serviceName: "auth",
    otelEndpoint: env.otelEndpoint,
    appLayer: makeAuthLayer(env),
  });
}
