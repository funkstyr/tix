import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import * as auth from "./schema/auth";
import * as post from "./schema/post";

export const schema = { ...auth, ...post };

export { myTable as tableCreator } from "./schema/_table";

export * from "drizzle-orm";

const psClient = new Client({
  host: process.env.DB_HOST!,
  user: process.env.DB_USERNAME!,
  password: process.env.DB_PASSWORD!,
});

export const db = drizzle(psClient, { schema });
