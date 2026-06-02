# Runbook: Postgres replication lag high

Alert: `pg-replication-lag` (ticket). Dashboard: **datastore-health**.

## Symptom

`max(pg_replication_lag_seconds) > 30` — a read replica is trailing the primary by more than 30s.
Reads served by that replica are stale, and a failover would lose the un-replayed window.

> Dev/kind runs a single Postgres with no replica, so this alert is silent there (no series →
> noDataState OK). It is meaningful only once prod runs replicas.

## Likely cause

- Replica under-provisioned (CPU/IO) and can't keep up with primary WAL volume.
- A long-running query on the replica blocking WAL replay (`hot_standby_feedback` conflicts).
- Network saturation between primary and replica, or a write spike on the primary.

## Checks

- **datastore-health** board: the replication-lag series on the "xact rollback + replication lag"
  panel.
- On the primary: `SELECT * FROM pg_stat_replication;` — `replay_lag`, `write_lag`, `state`.
- On the replica: `SELECT pg_last_wal_replay_lsn(), pg_is_in_recovery();` and check for blocking
  queries (`pg_stat_activity` with `wait_event_type = 'Lock'`).

## Remediation

- Kill the blocking query on the replica if replay is stuck.
- Scale the replica's resources, or shed read load off it temporarily.
- If the primary is write-saturated, throttle the write source (e.g. a bulk job).
- Confirm lag falls back under 30s on the board.
