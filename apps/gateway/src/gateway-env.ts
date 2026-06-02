import { ArkErrors, type } from "arktype";

const DEFAULT_PORT = 4000;
const DEFAULT_SESSION_COOKIE_NAME = "tix.session";
const DEFAULT_OTEL_ENDPOINT = "http://otel-collector:4318";
const DEFAULT_FARO_COLLECTOR_URL = "http://otel-collector:8090/";

const envSchema = type({
  "GATEWAY_HTTP_PORT?": "string.numeric.parse",
  WEB_ORIGIN: "string > 0",
  AUTH_BASE_URL: "string > 0",
  TICKETS_BASE_URL: "string > 0",
  ORDERS_BASE_URL: "string > 0",
  PAYMENTS_BASE_URL: "string > 0",
  "SESSION_COOKIE_NAME?": "string > 0",
  "OTEL_EXPORTER_OTLP_ENDPOINT?": "string > 0",
  "FARO_COLLECTOR_URL?": "string > 0",
});

export type GatewayEnv = {
  port: number;
  webOrigin: string;
  authBaseUrl: string;
  ticketsBaseUrl: string;
  ordersBaseUrl: string;
  paymentsBaseUrl: string;
  sessionCookieName: string;
  otelEndpoint: string;
  faroCollectorUrl: string;
};

export function parseEnv(env: Record<string, string | undefined>): GatewayEnv {
  const parsed = envSchema(env);
  if (parsed instanceof ArkErrors) {
    throw new Error(`invalid environment: ${parsed.summary}`);
  }

  const port = parsed.GATEWAY_HTTP_PORT ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid GATEWAY_HTTP_PORT: ${port}`);
  }

  return {
    port,
    webOrigin: parsed.WEB_ORIGIN,
    authBaseUrl: parsed.AUTH_BASE_URL,
    ticketsBaseUrl: parsed.TICKETS_BASE_URL,
    ordersBaseUrl: parsed.ORDERS_BASE_URL,
    paymentsBaseUrl: parsed.PAYMENTS_BASE_URL,
    sessionCookieName: parsed.SESSION_COOKIE_NAME ?? DEFAULT_SESSION_COOKIE_NAME,
    otelEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTEL_ENDPOINT,
    faroCollectorUrl: parsed.FARO_COLLECTOR_URL ?? DEFAULT_FARO_COLLECTOR_URL,
  };
}
