import type { RouterClient } from "@orpc/server";

import type { GatewayRouterClient } from "@tix/contracts/gateway";

import type { GatewayRouter } from "./gateway-router.ts";

// Compile-time check: the procedures the web client expects to call
// (`GatewayRouterClient`) must match the procedures the server exposes
// (`RouterClient<GatewayRouter>`). If a procedure is added, removed, or
// renamed on either side without updating the other, this tuple fails to
// type-check. I/O schemas come from `@tix/contracts/*` and are shared by
// both sides — only the set of procedures can drift, so that's what we pin.
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

type Assert<T extends true> = T;

type ServerClient = RouterClient<GatewayRouter>;

export type GatewayContractKeysMatch = [
  Assert<Equals<keyof ServerClient, keyof GatewayRouterClient>>,
  Assert<Equals<keyof ServerClient["tickets"], keyof GatewayRouterClient["tickets"]>>,
  Assert<Equals<keyof ServerClient["orders"], keyof GatewayRouterClient["orders"]>>,
  Assert<Equals<keyof ServerClient["payments"], keyof GatewayRouterClient["payments"]>>,
];
