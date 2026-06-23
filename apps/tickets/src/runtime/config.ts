import { type } from "arktype";

import { ORDERS_STREAM } from "@tix/contracts/subjects";
import { parseEnvSchema, requirePort } from "@tix/service-runtime/env";

const DEFAULT_PORT = 4002;
const DEFAULT_OTEL_ENDPOINT = "http://otel-collector:4318";

const envSchema = type({
  "TICKETS_HTTP_PORT?": "string.numeric.parse",
  DATABASE_URL: "string > 0",
  AUTH_BASE_URL: "string > 0",
  NATS_URL: "string > 0",
  TICKETS_SERVICE_TOKEN: "string > 0",
  "ORDERS_STREAM?": "string > 0",
  "OTEL_EXPORTER_OTLP_ENDPOINT?": "string > 0",
});

export type TicketsEnv = {
  port: number;
  databaseUrl: string;
  authBaseUrl: string;
  natsUrl: string;
  serviceToken: string;
  ordersStream: string;
  otelEndpoint: string;
};

export function parseEnv(): TicketsEnv {
  const parsed = parseEnvSchema(envSchema, process.env);

  return {
    port: requirePort(parsed.TICKETS_HTTP_PORT, DEFAULT_PORT, "TICKETS_HTTP_PORT"),
    databaseUrl: parsed.DATABASE_URL,
    authBaseUrl: parsed.AUTH_BASE_URL,
    natsUrl: parsed.NATS_URL,
    serviceToken: parsed.TICKETS_SERVICE_TOKEN,
    ordersStream: parsed.ORDERS_STREAM ?? ORDERS_STREAM,
    otelEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTEL_ENDPOINT,
  };
}
