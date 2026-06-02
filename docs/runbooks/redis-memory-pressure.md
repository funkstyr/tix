# Runbook: Redis memory near maxmemory

Alert: `redis-memory-pressure` (ticket). Dashboard: **datastore-health**.

## Symptom

`redis_memory_used_bytes / (redis_memory_max_bytes > 0) > 0.9` — Redis is using more than 90% of its
configured `maxmemory`. Evictions (`redis-eviction`, a page) are imminent.

> The `> 0` guard means this fires only when a `maxmemory` is set. Dev redis runs unbounded
> (`maxmemory 0`), so the alert is silent there — it's a prod signal.

## Likely cause

- Organic growth toward the cap (more queued jobs, more keys).
- A backlog: the expiration queue or another BullMQ structure growing faster than it drains.
- `maxmemory` provisioned too small.

## Checks

- **datastore-health** board: "Redis memory" panel (used vs max trend).
- `redis-cli INFO memory` — `used_memory`, `maxmemory`, `mem_fragmentation_ratio`.
- **saturation** board: expiration queue depth — is the growth a backed-up queue?

## Remediation

- Drain the backlog (fix the slow consumer; see `queue-depth.md`).
- Raise `maxmemory` if the workload legitimately needs more headroom.
- This is a ticket, not a page — act before it crosses into eviction. Confirm usage trends back down.
