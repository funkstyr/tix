import { Context, Effect, Layer } from "effect";

import { createDownstreamClients, type DownstreamClients } from "./downstream-clients.ts";
import type { GatewayEnv } from "./gateway-env.ts";

// Service tags. `GatewayConfig` feeds the downstream-client construction; `Downstream`
// is the only service the router handlers resolve (the config stays internal).
export class GatewayConfig extends Context.Tag("gateway/GatewayConfig")<
  GatewayConfig,
  GatewayEnv
>() {}

export class Downstream extends Context.Tag("gateway/Downstream")<
  Downstream,
  DownstreamClients
>() {}

export function makeGatewayConfigLayer(env: GatewayEnv): Layer.Layer<GatewayConfig> {
  return Layer.succeed(GatewayConfig, env);
}

// The downstream oRPC clients are pure constructions over the configured base URLs;
// `traceparentHeaders` (wired inside `makeClient`) reads the active span per request.
export const DownstreamLayer: Layer.Layer<Downstream, never, GatewayConfig> = Layer.effect(
  Downstream,
  Effect.map(GatewayConfig, (env) =>
    createDownstreamClients({
      ticketsBaseUrl: env.ticketsBaseUrl,
      ordersBaseUrl: env.ordersBaseUrl,
      paymentsBaseUrl: env.paymentsBaseUrl,
      authBaseUrl: env.authBaseUrl,
    }),
  ),
);
