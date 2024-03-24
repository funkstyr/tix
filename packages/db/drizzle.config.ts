import type { Config } from "drizzle-kit";

const connectionString = [
  "postgres://",
  process.env.DB_USERNAME,
  ":",
  process.env.DB_PASSWORD,
  "@",
  process.env.DB_HOST,
  ":5432/",
  process.env.DB_NAME,
].join("");

export default {
  schema: "./src/schema",
  driver: "pg",
  dbCredentials: { connectionString },
  tablesFilter: ["tix_*"],
} satisfies Config;
