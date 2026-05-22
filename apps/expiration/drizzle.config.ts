import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/expiration-schema.ts",
  out: "./drizzle",
  schemaFilter: ["expiration"],
  dbCredentials: {
    get url(): string {
      const u = process.env["DATABASE_URL"];
      if (!u) throw new Error("DATABASE_URL is required for drizzle-kit migrate/push");

      return u;
    },
  },
});
