import { ArkErrors, type } from "arktype";
import type { Level } from "pino";

const DEFAULT_PORT = 4000;

const envSchema = type({
  "GATEWAY_HTTP_PORT?": "string.numeric.parse",
  WEB_ORIGIN: "string > 0",
  AUTH_BASE_URL: "string > 0",
  TICKETS_BASE_URL: "string > 0",
  ORDERS_BASE_URL: "string > 0",
  PAYMENTS_BASE_URL: "string > 0",
  "LOG_LEVEL?": "'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'",
});

export type GatewayEnv = {
  port: number;
  webOrigin: string;
  authBaseUrl: string;
  ticketsBaseUrl: string;
  ordersBaseUrl: string;
  paymentsBaseUrl: string;
  logLevel: Level;
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
    logLevel: parsed.LOG_LEVEL ?? "info",
  };
}
