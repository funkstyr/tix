import { serve } from "@hono/node-server";

import { createDbClient } from "@tix/db-core/client";

import { createAuthApp } from "./auth-app.ts";
import { createAuth } from "./auth-instance.ts";
import { createLogger } from "./auth-logger.ts";
import { authTables } from "./auth-schema.ts";

const DEFAULT_PORT = 4001;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);

  return value;
}

async function main(): Promise<void> {
  const logger = createLogger({ name: "auth" });

  const port = Number(process.env["AUTH_HTTP_PORT"] ?? DEFAULT_PORT);
  const databaseUrl = requireEnv("DATABASE_URL");
  const secret = requireEnv("BETTER_AUTH_SECRET");
  const baseURL = process.env["AUTH_BASE_URL"] ?? `http://localhost:${port}`;

  const { db } = createDbClient("auth", databaseUrl, { schema: authTables });
  const auth = createAuth({ db, secret, baseURL });
  const app = createAuthApp({ auth, logger });

  serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, "auth service listening");
  });
}

void main();
