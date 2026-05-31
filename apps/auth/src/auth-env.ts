import { ArkErrors, type } from "arktype";
import type { Level } from "pino";

const DEFAULT_PORT = 4001;
const DEFAULT_OTEL_ENDPOINT = "http://otel-collector:4318";

const envSchema = type({
  "AUTH_HTTP_PORT?": "string.numeric.parse",
  DATABASE_URL: "string > 0",
  BETTER_AUTH_SECRET: "string > 0",
  "AUTH_BASE_URL?": "string > 0",
  "OTEL_EXPORTER_OTLP_ENDPOINT?": "string > 0",
  "LOG_LEVEL?": "'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'",
});

export type AuthEnv = {
  port: number;
  databaseUrl: string;
  secret: string;
  baseURL: string;
  otelEndpoint: string;
  logLevel: Level;
};

export function parseEnv(env: Record<string, string | undefined>): AuthEnv {
  const parsed = envSchema(env);
  if (parsed instanceof ArkErrors) {
    throw new Error(`invalid environment: ${parsed.summary}`);
  }

  const port = parsed.AUTH_HTTP_PORT ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid AUTH_HTTP_PORT: ${port}`);
  }

  return {
    port,
    databaseUrl: parsed.DATABASE_URL,
    secret: parsed.BETTER_AUTH_SECRET,
    baseURL: parsed.AUTH_BASE_URL ?? `http://localhost:${port}`,
    otelEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTEL_ENDPOINT,
    logLevel: parsed.LOG_LEVEL ?? "info",
  };
}
