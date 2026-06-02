# Runbook: reservation conflict spike

Alert: `conflict-spike` (warning). Dashboard: **saturation**.

## Symptom

Combined reservation-conflict rate is elevated (`> 0.2/s` over 5m):
`reservation_conflicts_total` (orders that lost the inventory race) +
`tickets_reservation_conflicts_total` (ticket reservations that exhausted the optimistic-version
retry budget).

## Likely cause

- Hot inventory: many buyers racing for the same scarce ticket — some conflict loss is expected here
  and is correct behaviour (only one buyer wins). A spike means contention is unusually high.
- The optimistic-concurrency retry budget on tickets is too small for the current contention, so
  legitimate reservations are giving up.
- The k6 load generator's induced-race batches (dev) — expected to nudge this above baseline.

## Checks

- **saturation** board: available-inventory + pending-orders panels — confirm contention is on a
  small/scarce inventory set rather than broad failure.
- Split the two counters: is it order-side race loss, ticket-side retry exhaustion, or both? That
  tells you which side to look at.
- tickets / orders logs for the conflict log lines.

## Remediation

- If it's genuine hot-inventory contention, usually no action — conflicts are the correct outcome of
  the race; verify buyers who lost can retry against remaining inventory.
- If ticket-side retry exhaustion dominates, consider tuning the optimistic retry budget.
- In dev, confirm the spike tracks the load generator's induced-race schedule rather than a real
  regression.
