import process from "node:process";
import { fileURLToPath } from "node:url";

// `apps/api-e2e/src/env.ts` → repo root is three levels up.
export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// Test fixtures committed in plain text on purpose — they only have meaning
// inside this script and the ephemeral infra it spins up. Prefix avoids any
// future secret-scanner false positive.
export const TEST_SERVICE_TOKEN = "e2e-fixture-service-token";
export const TEST_BETTER_AUTH_SECRET = "e2e-fixture-better-auth-secret-must-be-at-least-32-chars";
export const RESERVATION_TTL_MS = 5_000;
export const RESTORE_TIMEOUT_MS = 30_000;
export const SERVICE_READY_TIMEOUT_MS = 30_000;

function envOr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

// 127.0.0.1 (not "localhost") so IPv6 resolution can't route us to a stray dev
// server listening on ::1:<port> from another project.
export const env = {
  AUTH_DATABASE_URL: envOr(
    "AUTH_DATABASE_URL",
    "postgres://auth_user:auth_dev@localhost:5432/tix?search_path=auth",
  ),
  TICKETS_DATABASE_URL: envOr(
    "TICKETS_DATABASE_URL",
    "postgres://tickets_user:tickets_dev@localhost:5432/tix?search_path=tickets",
  ),
  ORDERS_DATABASE_URL: envOr(
    "ORDERS_DATABASE_URL",
    "postgres://orders_user:orders_dev@localhost:5432/tix?search_path=orders",
  ),
  EXPIRATION_DATABASE_URL: envOr(
    "EXPIRATION_DATABASE_URL",
    "postgres://expiration_user:expiration_dev@localhost:5432/tix?search_path=expiration",
  ),
  // Per-service roles only own their own schema, so drop/recreate during e2e
  // setup needs the admin role.
  ADMIN_DATABASE_URL: envOr(
    "ADMIN_DATABASE_URL",
    "postgres://postgres:postgres@localhost:5432/tix",
  ),
  NATS_URL: envOr("NATS_URL", "nats://localhost:4222"),
  REDIS_URL: envOr("REDIS_URL", "redis://localhost:6379"),
  AUTH_BASE_URL: "http://127.0.0.1:4001",
  TICKETS_BASE_URL: "http://127.0.0.1:4002",
  ORDERS_BASE_URL: "http://127.0.0.1:4003",
};
