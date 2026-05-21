import { and, eq, sql } from "drizzle-orm";
import { type AnyPgColumn, type PgTable } from "drizzle-orm/pg-core";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";

// `Record<string, unknown>` accepts any per-service schema via structural typing.
type AnyDb = PostgresJsDatabase<Record<string, unknown>>;

export type VersionedTable = PgTable & {
  id: AnyPgColumn;
  version: AnyPgColumn;
};

export type UpdateVersionedWhere = {
  id: string;
  version: number;
};

export type UpdateVersionedResult = {
  rowsAffected: number;
};

export async function updateVersioned<TTable extends VersionedTable>(
  tx: AnyDb,
  table: TTable,
  where: UpdateVersionedWhere,
  patch: Record<string, unknown>,
): Promise<UpdateVersionedResult> {
  // drizzle's `.set()` infers an exact column-keyed shape from the concrete table type,
  // which can't see the generic table's `version` column statically. Cast at this seam
  // — the runtime expects a key/value object of column name → value-or-SQL.
  const setValues = { ...patch, version: sql`${table.version} + 1` } as never;

  const updated = await tx
    .update(table)
    .set(setValues)
    .where(and(eq(table.id, where.id), eq(table.version, where.version)))
    .returning({ id: table.id });

  return { rowsAffected: updated.length };
}
