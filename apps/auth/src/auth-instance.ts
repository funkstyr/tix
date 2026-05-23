import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { authTables } from "./auth-schema.ts";

export type AuthDeps = {
  db: PostgresJsDatabase<typeof authTables>;
  secret: string;
  baseURL: string;
  // Browsers calling better-auth from an Origin other than `baseURL` get a
  // 400 unless that origin is in this list — needed when the SPA and the
  // auth service live on different ports (always, in this monorepo).
  trustedOrigins?: string[];
};

export type AuthInstance = ReturnType<typeof betterAuth>;

export function createAuth(deps: AuthDeps): AuthInstance {
  const options: BetterAuthOptions = {
    secret: deps.secret,
    baseURL: deps.baseURL,
    database: drizzleAdapter(deps.db, { provider: "pg", schema: authTables }),
    emailAndPassword: { enabled: true, autoSignIn: true },
    plugins: [bearer()],
    ...(deps.trustedOrigins === undefined ? {} : { trustedOrigins: deps.trustedOrigins }),
  };

  return betterAuth(options);
}
