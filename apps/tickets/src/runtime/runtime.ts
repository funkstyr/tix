import { Layer, type ManagedRuntime } from "effect";

import {
  eventPublisherLayer,
  makeAuthClientLayer,
  makeDatabaseLayer,
  makeNatsLayer,
} from "@tix/service-runtime/layers";
import { makeServiceRuntime } from "@tix/service-runtime/runtime";
import { AuthClient, EventPublisher, Nats } from "@tix/service-runtime/tags";

import { ticketsTables } from "../domain/schema.ts";
import type { TicketsEnv } from "./config.ts";
import { Database, makeTicketsConfigLayer, TicketsConfig } from "./services.ts";

export type TicketsServices = TicketsConfig | Database | Nats | EventPublisher | AuthClient;
export type TicketsRuntime = ManagedRuntime.ManagedRuntime<TicketsServices, never>;

export function makeTicketsLayer(env: TicketsEnv): Layer.Layer<TicketsServices> {
  const configLayer = makeTicketsConfigLayer(env);
  const resources = Layer.mergeAll(
    makeDatabaseLayer(Database, {
      schemaName: "tickets",
      databaseUrl: env.databaseUrl,
      schema: ticketsTables,
    }),
    makeNatsLayer({ serviceName: "tickets", natsUrl: env.natsUrl }),
    makeAuthClientLayer({ authBaseUrl: env.authBaseUrl }),
  );
  return eventPublisherLayer.pipe(Layer.provideMerge(resources), Layer.provideMerge(configLayer));
}

export function makeTicketsRuntime(env: TicketsEnv): TicketsRuntime {
  return makeServiceRuntime({
    serviceName: "tickets",
    otelEndpoint: env.otelEndpoint,
    appLayer: makeTicketsLayer(env),
  });
}
