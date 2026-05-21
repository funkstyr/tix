import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { authTables } from "./auth-schema.ts";

export type AuthDeps = {
  db: PostgresJsDatabase<typeof authTables>;
  secret: string;
  baseURL: string;
};

export type AuthInstance = ReturnType<typeof betterAuth>;

export function createAuth(deps: AuthDeps): AuthInstance {
  const options: BetterAuthOptions = {
    secret: deps.secret,
    baseURL: deps.baseURL,
    database: drizzleAdapter(deps.db, { provider: "pg", schema: authTables }),
    emailAndPassword: { enabled: true, autoSignIn: true },
    plugins: [bearer()],
  };

  return betterAuth(options);
}
