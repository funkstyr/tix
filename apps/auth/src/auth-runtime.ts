import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Layer, Logger, ManagedRuntime } from "effect";

import { globalContextManagerLayer } from "@tix/observability/otel-context";
import { otlpLayer } from "@tix/observability/otel-layer";

import type { AuthEnv } from "./auth-env.ts";
import { Auth, AuthLayer, DatabaseLayer, makeAuthConfigLayer } from "./auth-services.ts";

// The only service the runtime exposes is `Auth`, which the router resolves; the config
// and db client are provided internally to build it and aren't surfaced.
export type AuthRuntime = ManagedRuntime.ManagedRuntime<Auth, never>;

// Traces, logs, and metrics export over OTLP with the service name hard-set to "auth"
// (the endpoint comes from env, defaulting to the in-cluster collector). Hard-setting
// the name keeps the error channel `never`, so booting never depends on an env var.
//
// `globalContextManagerLayer` installs the async context manager that lets the OTLP
// tracer's span bridge reach the outbound-HTTP propagation paths (see otel-context.ts).
// `Logger.pretty` is local-dev console only; OTLP log export lives inside `otlpLayer`.
function makeObservabilityLayer(env: AuthEnv): Layer.Layer<never> {
  return Layer.mergeAll(
    otlpLayer({ serviceName: "auth", baseUrl: env.otelEndpoint }).pipe(
      Layer.provide(FetchHttpClient.layer),
    ),
    globalContextManagerLayer,
    Logger.pretty,
  );
}

// Config feeds the database, which feeds the better-auth issuer; observability is merged
// in alongside. `Layer.provide` builds `config`/`database` into the runtime's scope to
// satisfy `Auth` without surfacing them — and the scoped `Database` finalizer (the pool
// drain) still runs at disposal because it's part of that scope, not discarded.
export function makeAuthLayer(env: AuthEnv): Layer.Layer<Auth> {
  const config = makeAuthConfigLayer(env);
  const database = DatabaseLayer.pipe(Layer.provide(config));
  const auth = AuthLayer.pipe(Layer.provide(Layer.merge(config, database)));

  return Layer.merge(auth, makeObservabilityLayer(env));
}

export function makeAuthRuntime(env: AuthEnv): AuthRuntime {
  return ManagedRuntime.make(makeAuthLayer(env));
}
