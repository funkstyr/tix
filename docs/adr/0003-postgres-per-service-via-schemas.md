# Postgres per service via schemas in a single cluster

The "pure" microservice answer is one Postgres cluster per service — 5 StatefulSets, 5 PVCs, full physical isolation. The "lazy" answer is one shared database every service writes to. We pick the middle: **one Postgres cluster, one logical database, one schema per service** (`auth`, `tickets`, `orders`, `payments`, `expiration`). Each service connects with its own role; that role has `USAGE` on its own schema only. Cross-service reads are blocked at the database auth layer, not by convention.

## Why

- Local dev: one Postgres pod, fast `kind` startup, simple secrets.
- Migrations are still per-service (each service ships its own drizzle config pointing at its schema), so the "owns its data" rule holds at the code level.
- The split-to-per-database path is unblocked: change connection strings, run a logical dump per schema. We don't reach for it until prod actually needs it.

## Consequences

- Forgetting to set `search_path` in a service's connection string is a footgun — wrap the drizzle client in `@tix/db-core` so it's set once.
- Backups are coarser (whole-cluster), at least until we split.
- The CloudNativePG operator could simplify ops in prod, but is not required for `kind`.
