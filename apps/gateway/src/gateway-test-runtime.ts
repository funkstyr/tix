import { Layer } from "effect";

import { makeServiceTestRuntime } from "@tix/service-runtime/test";

import type { DownstreamClients } from "./downstream-clients.ts";
import type { GatewayRuntime } from "./gateway-runtime.ts";
import { Downstream } from "./gateway-services.ts";

export type GatewayTestDeps = {
  clients: DownstreamClients;
};

// Builds a ManagedRuntime from explicit downstream clients instead of the env-driven layer,
// so in-process tests and the canary stack drive the same Effect programs the router runs in
// production. OTLP is omitted.
export function createGatewayTestRuntime(deps: GatewayTestDeps): GatewayRuntime {
  return makeServiceTestRuntime(Layer.succeed(Downstream, deps.clients));
}
