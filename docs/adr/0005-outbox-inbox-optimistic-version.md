# Full reliability kit from day one: outbox + inbox + optimistic version

Every service implements the three patterns below. This is a deliberate departure from the original tutorial, which publishes events after the DB write (lossy on crash), and dedupes only loosely. The cost is real but the patterns are *the* lesson for distributed-systems learning.

## Outbox

Every event is inserted into a service-local `outbox` table in the **same transaction** as the domain row that produced it. A relay worker in the same service polls the outbox (or uses Postgres `LISTEN/NOTIFY`) and publishes to JetStream. On success, the row is marked sent; on crash mid-publish, the row is retried. Guarantees at-least-once publication without 2PC.

## Inbox

Every consumed event is recorded in a service-local `inbox` table with `(event_id, subject)` as a unique key, **before** business logic runs. A repeated delivery is detected and skipped. JetStream provides at-least-once; the inbox makes the consumer effectively exactly-once.

## Optimistic version

Every domain row (`tickets`, `orders`, …) has an integer `version` column. Updates are `WHERE id = ? AND version = ?` and bump `version` by 1. A failed update means a concurrent write won — the caller refetches and retries (or fails the request). This makes the reservation saga (ADR-0007) safe under concurrent buyers.

## Why upfront

- These patterns invert how you write service code; bolting them on later is a rewrite.
- The shared implementation lives in `@tix/db-core` and `@tix/messaging`, so each service pays the cost once.
- They are exactly the patterns the tutorial waves at — the rebuild is incomplete without them.

## Consequences

- All event publication goes through the outbox helper, never directly to the NATS client.
- All event handlers wrap business logic in an inbox check helper.
- Tests must exercise concurrent writes (testcontainers + parallel transactions) — otherwise the version checks are decorative.
