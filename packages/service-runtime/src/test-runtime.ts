import type { NatsConnection } from "@nats-io/transport-node";
import { Layer, Logger, ManagedRuntime } from "effect";

import type { AuthSessionClient } from "@tix/contracts/auth-client";
import type { Publisher } from "@tix/messaging/jetstream";

// Throwing stubs for the shared collaborators a given test omits, so an accidental
// dependency surfaces loudly instead of silently using a half-built runtime.
export function throwingNats(): NatsConnection {
  return new Proxy({} as NatsConnection, {
    get() {
      throw new Error("Nats not provided to test runtime");
    },
  });
}

export function throwingPublisher(): Publisher {
  return {
    publish: () => {
      throw new Error("EventPublisher not provided to test runtime");
    },
  };
}

export function throwingAuthClient(): AuthSessionClient {
  return {
    getSession: () => {
      throw new Error("AuthClient not provided to test runtime");
    },
  };
}

// Builds a ManagedRuntime from explicit, already-constructed collaborators (the test
// `appLayer`) plus `Logger.pretty`. OTLP is omitted — logs go through the pretty logger.
export function makeServiceTestRuntime<R>(
  appLayer: Layer.Layer<R>,
): ManagedRuntime.ManagedRuntime<R, never> {
  return ManagedRuntime.make(Layer.merge(appLayer, Logger.pretty));
}
