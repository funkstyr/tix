# Hybrid reservation saga: synchronous reserve, asynchronous release

When a Buyer creates an Order, the Orders service calls **synchronously** into the Tickets service (via orpc) to atomically decrement `Ticket.quantityAvailable` by the Order's `quantity`. If the call succeeds, the Order is persisted in `created` and `order.created.v1` is published. If it fails (sold out, optimistic-version conflict after a brief retry), the HTTP request fails — no Order row is created.

When an Order moves to `cancelled` or `expired`, Orders publishes `order.reservation_released.v1` **asynchronously** via the outbox. Tickets consumes that event and restores `quantityAvailable`. There is no synchronous release path.

## Why not pure choreography

Pure event-driven reservation (publish `reservation_requested`, wait for `reservation_confirmed`) means the Buyer sees an HTTP 202 and polls for status — bad UX for "did my purchase work?" The synchronous reserve gives a clear yes/no in one request and avoids modeling a `pending_reservation` Order state that only exists to absorb the race.

## Why not pure orchestration

A synchronous release on cancel/expire would couple the Orders state machine to Tickets availability. If Tickets is down for 30 seconds, no Order can be cancelled — including by the Expiration worker, which then piles up. Async release lets the Order reach its terminal state immediately; inventory restoration is eventual.

## Consequences

- The Order's terminal state may briefly precede the inventory restoration on the Ticket. Acceptable: a Ticket whose inventory hasn't returned yet just shows lower availability for a moment.
- Tickets service must be **highly available** for reads/reservations — it's on every Buyer's request path. Cancel/expire is not.
- The reserve call uses optimistic-version (ADR-0005) and may retry once on conflict before failing.
