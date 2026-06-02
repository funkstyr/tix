# Runbook: Redis is evicting keys

Alert: `redis-eviction` (page). Dashboard: **datastore-health**.

## Symptom

`sum(rate(redis_evicted_keys_total[5m])) > 0` — Redis is evicting keys under memory pressure. This
should be ~0 always: BullMQ (the expiration worker's delayed-job queue) stores jobs as Redis keys,
so an eviction can drop a queued Order-expiration job — the Order then never auto-cancels.

## Likely cause

- Redis hit `maxmemory` and the eviction policy started reclaiming keys.
- A memory leak or unbounded growth (a queue backing up, or stale keys never expiring).
- `maxmemory` set too low for the workload.

## Checks

- **datastore-health** board: the "Redis evictions" and "Redis memory" panels (used vs max).
- `redis-cli INFO memory` — `used_memory`, `maxmemory`, `maxmemory_policy`, `evicted_keys`.
- `redis-cli INFO keyspace` and the **saturation** board's expiration queue depth — is BullMQ
  backing up?

## Remediation

- If a queue is backed up, fix the consumer (see `queue-depth.md`) so keys drain.
- Raise `maxmemory`, or switch the policy to `noeviction` so BullMQ keys are never silently dropped
  (writes then fail loudly instead — preferable for a job queue).
- Check for un-expiring keys and add TTLs where appropriate.
- **Re-verify the expiration saga**: any Order whose job was evicted may be stuck — reconcile.
- Confirm the eviction rate returns to zero.
