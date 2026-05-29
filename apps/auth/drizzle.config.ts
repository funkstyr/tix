import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/auth-schema.ts",
  out: "./drizzle",
  schemaFilter: ["auth"],
  // Keep the migration log inside this service's own schema rather than the
  // default global `drizzle` schema. One Postgres database is shared across
  // services (ADR-0003) and each migrates as its own role — a shared log schema
  // would be owned by whichever service ran first and reject the others.
  // Mirrors apps/api-e2e/src/migrate.ts's `migrationsSchema`.
  migrations: { schema: "auth" },
  dbCredentials: {
    get url(): string {
      const u = process.env["DATABASE_URL"];
      if (!u) throw new Error("DATABASE_URL is required for drizzle-kit migrate/push");

      return u;
    },
  },
});
