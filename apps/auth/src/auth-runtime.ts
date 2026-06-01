import { Layer, type ManagedRuntime } from "effect";

import { makeDatabaseLayer } from "@tix/service-runtime/layers";
import { makeServiceRuntime } from "@tix/service-runtime/runtime";

import type { AuthEnv } from "./auth-env.ts";
import { authTables } from "./auth-schema.ts";
import { Auth, AuthLayer, Database, makeAuthConfigLayer } from "./auth-services.ts";

// The only service the runtime exposes is `Auth`; config and db are provided internally to
// build it and aren't surfaced. The scoped `Database` finalizer (pool drain) still runs at
// disposal because it's part of the runtime's scope.
export type AuthRuntime = ManagedRuntime.ManagedRuntime<Auth, never>;

export function makeAuthLayer(env: AuthEnv): Layer.Layer<Auth> {
  const config = makeAuthConfigLayer(env);
  const database = makeDatabaseLayer(Database, {
    schemaName: "auth",
    databaseUrl: env.databaseUrl,
    schema: authTables,
  });
  return AuthLayer.pipe(Layer.provide(Layer.merge(config, database)));
}

export function makeAuthRuntime(env: AuthEnv): AuthRuntime {
  return makeServiceRuntime({
    serviceName: "auth",
    otelEndpoint: env.otelEndpoint,
    appLayer: makeAuthLayer(env),
  });
}
