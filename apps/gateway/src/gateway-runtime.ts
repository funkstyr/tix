import { Layer, type ManagedRuntime } from "effect";

import { makeServiceRuntime } from "@tix/service-runtime/runtime";

import type { GatewayEnv } from "./gateway-env.ts";
import { Downstream, DownstreamLayer, makeGatewayConfigLayer } from "./gateway-services.ts";

export type GatewayRuntime = ManagedRuntime.ManagedRuntime<Downstream, never>;

export function makeGatewayLayer(env: GatewayEnv): Layer.Layer<Downstream> {
  return DownstreamLayer.pipe(Layer.provide(makeGatewayConfigLayer(env)));
}

export function makeGatewayRuntime(env: GatewayEnv): GatewayRuntime {
  return makeServiceRuntime({
    serviceName: "gateway",
    otelEndpoint: env.otelEndpoint,
    appLayer: makeGatewayLayer(env),
  });
}
