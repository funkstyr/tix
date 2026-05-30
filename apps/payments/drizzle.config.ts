import { defineConfig } from "drizzle-kit";
import { existsSync } from "node:fs";

// Load this service's `.env` (the same file `pnpm dev` reads via
// `--env-file-if-exists`) so `db:migrate`/`db:generate` see DATABASE_URL.
// drizzle-kit has no `--env-file` flag. No-op in CI / k8s, where the env is
// injected and no `.env` file is present.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/payments-schema.ts",
  out: "./drizzle",
  schemaFilter: ["payments"],
  // Migration log lives in this service's own schema, not the shared global
  // `drizzle` schema — see apps/auth/drizzle.config.ts for the rationale.
  migrations: { schema: "payments" },
  dbCredentials: {
    get url(): string {
      const u = process.env["DATABASE_URL"];
      if (!u) throw new Error("DATABASE_URL is required for drizzle-kit migrate/push");

      return u;
    },
  },
});
