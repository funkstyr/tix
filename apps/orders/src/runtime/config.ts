import { type } from "arktype";

import { ORDERS_STREAM, PAYMENTS_STREAM, TICKETS_STREAM } from "@tix/contracts/subjects";
import { parseEnvSchema, requirePort, requirePositiveInt } from "@tix/service-runtime/env";

const DEFAULT_PORT = 4003;
const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_OTEL_ENDPOINT = "http://otel-collector:4318";

const envSchema = type({
  "ORDERS_HTTP_PORT?": "string.numeric.parse",
  DATABASE_URL: "string > 0",
  AUTH_BASE_URL: "string > 0",
  TICKETS_BASE_URL: "string > 0",
  TICKETS_SERVICE_TOKEN: "string > 0",
  NATS_URL: "string > 0",
  "ORDERS_STREAM?": "string > 0",
  "PAYMENTS_STREAM?": "string > 0",
  "TICKETS_STREAM?": "string > 0",
  "RESERVATION_TTL_MS?": "string.numeric.parse",
  "OTEL_EXPORTER_OTLP_ENDPOINT?": "string > 0",
});

export type OrdersEnv = {
  port: number;
  databaseUrl: string;
  authBaseUrl: string;
  ticketsBaseUrl: string;
  ticketsServiceToken: string;
  natsUrl: string;
  stream: string;
  paymentsStream: string;
  ticketsStream: string;
  reservationTtlMs: number;
  otelEndpoint: string;
};

export function parseEnv(): OrdersEnv {
  const parsed = parseEnvSchema(envSchema, process.env);

  return {
    port: requirePort(parsed.ORDERS_HTTP_PORT, DEFAULT_PORT, "ORDERS_HTTP_PORT"),
    databaseUrl: parsed.DATABASE_URL,
    authBaseUrl: parsed.AUTH_BASE_URL,
    ticketsBaseUrl: parsed.TICKETS_BASE_URL,
    ticketsServiceToken: parsed.TICKETS_SERVICE_TOKEN,
    natsUrl: parsed.NATS_URL,
    stream: parsed.ORDERS_STREAM ?? ORDERS_STREAM,
    paymentsStream: parsed.PAYMENTS_STREAM ?? PAYMENTS_STREAM,
    ticketsStream: parsed.TICKETS_STREAM ?? TICKETS_STREAM,
    reservationTtlMs: requirePositiveInt(
      parsed.RESERVATION_TTL_MS,
      DEFAULT_RESERVATION_TTL_MS,
      "RESERVATION_TTL_MS",
    ),
    otelEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTEL_ENDPOINT,
  };
}
