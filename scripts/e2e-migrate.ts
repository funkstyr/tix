import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import postgres from "postgres";

import { env, repoRoot } from "./e2e-env.ts";

type Target = {
  schema: string;
  role: string;
  url: string;
  folder: string;
};

const targets: readonly Target[] = [
  { schema: "auth", role: "auth_user", url: env.AUTH_DATABASE_URL, folder: "apps/auth/drizzle" },
  {
    schema: "tickets",
    role: "tickets_user",
    url: env.TICKETS_DATABASE_URL,
    folder: "apps/tickets/drizzle",
  },
  {
    schema: "orders",
    role: "orders_user",
    url: env.ORDERS_DATABASE_URL,
    folder: "apps/orders/drizzle",
  },
  {
    schema: "expiration",
    role: "expiration_user",
    url: env.EXPIRATION_DATABASE_URL,
    folder: "apps/expiration/drizzle",
  },
];

// Drop + recreate each per-service schema as admin before migrating, so a
// stale schema from an earlier run (or a docker volume with old migrations)
// can't poison the test. Each service then migrates as its own role into its
// own schema, with the migration log scoped to that schema (not the default
// global `drizzle` schema) so per-service roles don't need CREATE on the
// database at migrate-log time.
export async function runMigrations(): Promise<void> {
  const admin = postgres(env.ADMIN_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop -- serial setup against one admin connection
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${target.schema}" CASCADE`);
      // eslint-disable-next-line no-await-in-loop -- serial setup against one admin connection
      await admin.unsafe(`CREATE SCHEMA "${target.schema}" AUTHORIZATION ${target.role}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  for (const target of targets) {
    const sql = postgres(target.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const db = drizzle(sql);
      // eslint-disable-next-line no-await-in-loop -- migrate per service, sequential to avoid log contention
      await migrate(db, {
        migrationsFolder: path.join(repoRoot, target.folder),
        migrationsSchema: target.schema,
      });
    } finally {
      // eslint-disable-next-line no-await-in-loop -- close per-service connection before opening the next
      await sql.end({ timeout: 5 });
    }
  }
}
