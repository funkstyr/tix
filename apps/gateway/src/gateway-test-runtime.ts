import { Layer, Logger, ManagedRuntime } from "effect";

import type { DownstreamClients } from "./downstream-clients.ts";
import type { GatewayRuntime } from "./gateway-runtime.ts";
import { Downstream } from "./gateway-services.ts";

export type GatewayTestDeps = {
  clients: DownstreamClients;
};

// Builds a ManagedRuntime from explicit, already-constructed downstream clients
// instead of the env-driven layer, so in-process tests and the canary stack drive
// the same Effect programs the router runs in production. OTLP is omitted — logs go
// through Effect's pretty logger.
export function createGatewayTestRuntime(deps: GatewayTestDeps): GatewayRuntime {
  return ManagedRuntime.make(Layer.merge(Layer.succeed(Downstream, deps.clients), Logger.pretty));
}
