# Runbook: Postgres deadlock spike

Alert: `pg-deadlock-spike` (warning). Dashboard: **datastore-health**.

## Symptom

`sum(rate(pg_stat_database_deadlocks[5m])) > 0` — Postgres is detecting and aborting deadlocks.
Each deadlock means two transactions grabbed locks in opposite orders; one is rolled back with
`deadlock detected`, surfacing to a service as a failed write (often a 500 or a retried saga step).

## Likely cause

- Inconsistent lock ordering across code paths writing the same rows (e.g. two updates touching
  `orders` and `tickets` in different orders).
- A hot row under high contention (the reservation race) combined with `SELECT ... FOR UPDATE`.
- A long transaction holding locks while another waits.

## Checks

- **datastore-health** board: the deadlocks panel shows the rate and which database.
- Postgres logs (`kubectl -n tix logs statefulset/postgres`) print the full deadlock detail —
  the two PIDs, their queries, and the lock cycle. This is the fastest way to the offending pair.
- Correlate with the `saga-funnel` / `saturation` boards for a concurrent conflict spike.

## Remediation

- Fix the lock ordering: make the conflicting code paths acquire rows in a consistent order.
- Shorten transactions holding locks; move non-essential work out of the transaction.
- For the reservation hot path, ensure the optimistic-version retry (not a long `FOR UPDATE`) is the
  contention strategy.
- Confirm the deadlock rate returns to zero on the board.
