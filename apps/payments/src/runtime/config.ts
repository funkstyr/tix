import { ArkErrors, type } from "arktype";

import { ORDERS_STREAM, PAYMENTS_STREAM } from "@tix/contracts/subjects";

const DEFAULT_PORT = 4004;
const DEFAULT_OTEL_ENDPOINT = "http://otel-collector:4318";

const envSchema = type({
  "PAYMENTS_HTTP_PORT?": "string.numeric.parse",
  DATABASE_URL: "string > 0",
  AUTH_BASE_URL: "string > 0",
  NATS_URL: "string > 0",
  STRIPE_KEY: "string > 0",
  "PAYMENTS_STREAM?": "string > 0",
  "ORDERS_STREAM?": "string > 0",
  "OTEL_EXPORTER_OTLP_ENDPOINT?": "string > 0",
});

export type PaymentsEnv = {
  port: number;
  databaseUrl: string;
  authBaseUrl: string;
  natsUrl: string;
  stripeKey: string;
  // payments' own stream (where it publishes payment.* events).
  stream: string;
  // The ORDERS stream the order-projection consumers read from — `order.*` events live there,
  // not in PAYMENTS, so binding the projection consumers to `stream` would match nothing.
  ordersStream: string;
  otelEndpoint: string;
};

export function parseEnv(): PaymentsEnv {
  const parsed = envSchema(process.env);
  if (parsed instanceof ArkErrors) {
    throw new Error(`invalid environment: ${parsed.summary}`);
  }

  const port = parsed.PAYMENTS_HTTP_PORT ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid PAYMENTS_HTTP_PORT: ${port}`);
  }

  return {
    port,
    databaseUrl: parsed.DATABASE_URL,
    authBaseUrl: parsed.AUTH_BASE_URL,
    natsUrl: parsed.NATS_URL,
    stripeKey: parsed.STRIPE_KEY,
    stream: parsed.PAYMENTS_STREAM ?? PAYMENTS_STREAM,
    ordersStream: parsed.ORDERS_STREAM ?? ORDERS_STREAM,
    otelEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTEL_ENDPOINT,
  };
}
