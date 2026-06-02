# Runbook: Postgres connection pool near exhaustion

Alert: `pg-pool-exhaustion` (page). Dashboard: **datastore-health**.

## Symptom

`sum(pg_stat_activity_count) / max(pg_settings_max_connections) > 0.9` — in-use connections are
within 10% of `max_connections`. Once it hits the cap, every new connection (and every service that
needs one) starts erroring with "too many clients already".

## Likely cause

- A service leaking connections (pool not releasing) or a sudden traffic spike.
- A long-running / stuck transaction holding connections open (`idle in transaction`).
- `max_connections` set too low for the number of service replicas × their pool sizes.

## Checks

- **datastore-health** board: the "Postgres connections" panel shows in-use vs max over time.
- `SELECT state, count(*) FROM pg_stat_activity GROUP BY state;` — lots of `idle in transaction`
  points at a leak; lots of `active` points at load.
- `SELECT pid, state, query_start, query FROM pg_stat_activity ORDER BY query_start;` — find the
  oldest / stuck sessions.

## Remediation

- Kill stuck sessions: `SELECT pg_terminate_backend(<pid>);` for `idle in transaction` leaks.
- Restart the offending service to drop its pool if it's leaking.
- Longer term: lower per-service pool sizes, add PgBouncer, or raise `max_connections` (costs RAM).
- Confirm the connection ratio drops back below 0.9 on the board.
