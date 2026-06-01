import { Layer, type ManagedRuntime } from "effect";

import { eventPublisherLayer, makeDatabaseLayer, makeNatsLayer } from "@tix/service-runtime/layers";
import { makeServiceRuntime } from "@tix/service-runtime/runtime";
import { EventPublisher, Nats } from "@tix/service-runtime/tags";

import { expirationTables } from "../expiration-schema.ts";
import type { ExpirationEnv } from "./config.ts";
import {
  Database,
  ExpirationConfig,
  makeExpirationConfigLayer,
  Scheduler,
  SchedulerLayer,
} from "./services.ts";

export type ExpirationServices = ExpirationConfig | Database | Nats | EventPublisher | Scheduler;
export type ExpirationRuntime = ManagedRuntime.ManagedRuntime<ExpirationServices, never>;

export function makeExpirationLayer(env: ExpirationEnv): Layer.Layer<ExpirationServices> {
  const configLayer = makeExpirationConfigLayer(env);
  const resources = Layer.mergeAll(
    makeDatabaseLayer(Database, {
      schemaName: "expiration",
      databaseUrl: env.databaseUrl,
      schema: expirationTables,
    }),
    makeNatsLayer({ serviceName: "expiration", natsUrl: env.natsUrl }),
    SchedulerLayer,
  );
  return eventPublisherLayer.pipe(Layer.provideMerge(resources), Layer.provideMerge(configLayer));
}

export function makeExpirationRuntime(env: ExpirationEnv): ExpirationRuntime {
  return makeServiceRuntime({
    serviceName: "expiration",
    otelEndpoint: env.otelEndpoint,
    appLayer: makeExpirationLayer(env),
  });
}
