import { Effect } from "effect";

// Per-query DB span (ADR-0009 promised "one span per wrapped DB transaction"; ADR-0011 Tier 2
// delivers it). Wraps a drizzle/postgres-js Effect so query latency — where latency usually
// hides — shows in Tempo, carrying the OTel database semantic-convention attributes. Applied at
// the repository/transaction call site (we instrument explicitly rather than monkey-patching
// the client, keeping `@tix/db-core` a plain typed client). `db.sql.table` is the logical
// `<schema>.<table>` (or the saga step name for multi-table transactions).
export function dbSpan<A, E, R>(
  operation: string,
  table: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.withSpan(`db.${operation}`, {
      attributes: {
        "db.system": "postgresql",
        "db.operation": operation,
        "db.sql.table": table,
      },
    }),
  );
}
