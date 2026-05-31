import { ArkErrors, type } from "arktype";

import { ORDERS_STREAM } from "@tix/contracts/subjects";

const DEFAULT_OTEL_ENDPOINT = "http://otel-collector:4318";

const envSchema = type({
  DATABASE_URL: "string > 0",
  NATS_URL: "string > 0",
  REDIS_URL: "string > 0",
  "EXPIRATION_STREAM?": "string > 0",
  "OTEL_EXPORTER_OTLP_ENDPOINT?": "string > 0",
});

export type ExpirationEnv = {
  databaseUrl: string;
  natsUrl: string;
  redis: { host: string; port: number };
  stream: string;
  otelEndpoint: string;
};

function parseRedisUrl(raw: string): { host: string; port: number } {
  const url = new URL(raw);
  if (!url.hostname) throw new Error(`REDIS_URL missing host: ${raw}`);

  const port = url.port ? Number(url.port) : 6379;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid REDIS_URL port: ${raw}`);
  }

  return { host: url.hostname, port };
}

export function parseEnv(): ExpirationEnv {
  const parsed = envSchema(process.env);
  if (parsed instanceof ArkErrors) {
    throw new Error(`invalid environment: ${parsed.summary}`);
  }

  return {
    databaseUrl: parsed.DATABASE_URL,
    natsUrl: parsed.NATS_URL,
    redis: parseRedisUrl(parsed.REDIS_URL),
    stream: parsed.EXPIRATION_STREAM ?? ORDERS_STREAM,
    otelEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTEL_ENDPOINT,
  };
}
