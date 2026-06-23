import { type } from "arktype";

import { parseEnvSchema, requirePort } from "@tix/service-runtime/env";

const DEFAULT_PORT = 4001;
const DEFAULT_OTEL_ENDPOINT = "http://otel-collector:4318";

const envSchema = type({
  "AUTH_HTTP_PORT?": "string.numeric.parse",
  DATABASE_URL: "string > 0",
  BETTER_AUTH_SECRET: "string > 0",
  "AUTH_BASE_URL?": "string > 0",
  // The SPA's browser origin. better-auth `baseURL` is the in-cluster `http://auth:<port>`,
  // so a browser POSTing sign-in/sign-up from the SPA is cross-origin and gets a 403
  // `INVALID_ORIGIN` unless that origin is trusted. Optional so tests/standalone still boot.
  "WEB_ORIGIN?": "string > 0",
  "OTEL_EXPORTER_OTLP_ENDPOINT?": "string > 0",
});

export type AuthEnv = {
  port: number;
  databaseUrl: string;
  secret: string;
  baseURL: string;
  otelEndpoint: string;
  trustedOrigins?: string[];
};

export function parseEnv(env: Record<string, string | undefined>): AuthEnv {
  const parsed = parseEnvSchema(envSchema, env);
  const port = requirePort(parsed.AUTH_HTTP_PORT, DEFAULT_PORT, "AUTH_HTTP_PORT");

  return {
    port,
    databaseUrl: parsed.DATABASE_URL,
    secret: parsed.BETTER_AUTH_SECRET,
    baseURL: parsed.AUTH_BASE_URL ?? `http://localhost:${port}`,
    otelEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTEL_ENDPOINT,
    ...(parsed.WEB_ORIGIN === undefined ? {} : { trustedOrigins: [parsed.WEB_ORIGIN] }),
  };
}
