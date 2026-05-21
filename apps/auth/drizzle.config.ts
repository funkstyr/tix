import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/auth-schema.ts",
  out: "./drizzle",
  schemaFilter: ["auth"],
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgres://localhost/placeholder",
  },
});
