import { createRouterClient } from "@orpc/server";
import { type AuthInstance, createAuth } from "auth/instance";
import { migrationsFolder } from "auth/migrations";
import { createAuthRouter } from "auth/router";
import { authTables } from "auth/schema";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import type { AuthRouterClient } from "@tix/contracts/auth";
import {
  type AuthSessionClient,
  createInProcessAuthSessionClient,
} from "@tix/contracts/auth-client";
import { createDbClient, type DbClient } from "@tix/db-core/client";

const DEFAULT_TEST_SECRET = "test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod";

export type AuthFixtureDbClient = DbClient<typeof authTables>;

export type AuthFixtureOptions = {
  databaseUrl: string;
  baseUrl: string;
  secret?: string;
};

export type AuthFixture = {
  db: AuthFixtureDbClient;
  auth: AuthInstance;
  authClient: AuthRouterClient;
  authSessionClient: AuthSessionClient;
  truncate: () => Promise<void>;
  close: () => Promise<void>;
};

export async function createAuthFixture(options: AuthFixtureOptions): Promise<AuthFixture> {
  const db = createDbClient("auth", options.databaseUrl, { schema: authTables });
  await migrate(db.db, { migrationsFolder });

  const auth = createAuth({
    db: db.db,
    secret: options.secret ?? DEFAULT_TEST_SECRET,
    baseURL: options.baseUrl,
  });
  const router = createAuthRouter({ auth });
  const authClient: AuthRouterClient = createRouterClient(router);
  const authSessionClient = createInProcessAuthSessionClient(authClient);

  return {
    db,
    auth,
    authClient,
    authSessionClient,
    truncate: async () => {
      await db.sql`TRUNCATE TABLE auth.session, auth.account, auth.user RESTART IDENTITY CASCADE`;
    },
    close: async () => {
      await db.close();
    },
  };
}
