import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

export type DbClient<TSchema extends Record<string, unknown> = Record<string, never>> = {
  db: PostgresJsDatabase<TSchema>;
  sql: Sql;
  close: () => Promise<void>;
};

export type CreateDbClientOptions<TSchema extends Record<string, unknown>> = {
  schema?: TSchema;
  max?: number;
};

export function createDbClient<TSchema extends Record<string, unknown> = Record<string, never>>(
  schemaName: string,
  connectionString: string,
  options: CreateDbClientOptions<TSchema> = {},
): DbClient<TSchema> {
  const sql = postgres(connectionString, {
    max: options.max ?? 10,
    connection: { search_path: `${schemaName}, public` },
  });

  const db = (
    options.schema ? drizzle(sql, { schema: options.schema }) : drizzle(sql)
  ) as PostgresJsDatabase<TSchema>;

  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
