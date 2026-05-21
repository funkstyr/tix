import type { Sql } from "postgres";

export async function bootstrapSchema(sql: Sql, schemaName: string): Promise<void> {
  const ident = quoteIdent(schemaName);

  const existing = await sql<{ exists: number }[]>`
    SELECT 1 AS exists FROM pg_namespace WHERE nspname = ${schemaName}
  `;
  if (existing.length === 0) {
    await sql.unsafe(`CREATE SCHEMA ${ident}`);
  }

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${ident}.outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      subject text NOT NULL,
      payload jsonb NOT NULL,
      event_id uuid NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${ident}.inbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id uuid NOT NULL,
      subject text NOT NULL,
      consumed_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT inbox_event_subject_uq UNIQUE (event_id, subject)
    )
  `);
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid schema identifier: ${name}`);
  }
  return `"${name}"`;
}
