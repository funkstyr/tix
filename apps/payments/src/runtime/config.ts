import { ArkErrors, type } from "arktype";
import type { Level } from "pino";

import { PAYMENTS_STREAM } from "@tix/contracts/subjects";

const DEFAULT_PORT = 4004;
const DEFAULT_OTEL_ENDPOINT = "http://otel-collector:4318";

const envSchema = type({
  "PAYMENTS_HTTP_PORT?": "string.numeric.parse",
  DATABASE_URL: "string > 0",
  AUTH_BASE_URL: "string > 0",
  NATS_URL: "string > 0",
  STRIPE_KEY: "string > 0",
  "PAYMENTS_STREAM?": "string > 0",
  "OTEL_EXPORTER_OTLP_ENDPOINT?": "string > 0",
  "LOG_LEVEL?": "'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'",
});

export type PaymentsEnv = {
  port: number;
  databaseUrl: string;
  authBaseUrl: string;
  natsUrl: string;
  stripeKey: string;
  stream: string;
  otelEndpoint: string;
  logLevel: Level;
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
    otelEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTEL_ENDPOINT,
    logLevel: parsed.LOG_LEVEL ?? "info",
  };
}
