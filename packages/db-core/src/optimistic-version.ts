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
  // which can't see the generic table's `version` column statically. The runtime shape
  // is a record of column name → value-or-SQL; we declare that explicitly and confine
  // the `as never` to the `.set()` boundary.
  const setValues: Record<string, unknown> = {
    ...patch,
    version: sql`${table.version} + 1`,
  };

  const updated = await tx
    .update(table)
    .set(setValues as never)
    .where(and(eq(table.id, where.id), eq(table.version, where.version)))
    .returning({ id: table.id });

  return { rowsAffected: updated.length };
}
