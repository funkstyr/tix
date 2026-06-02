# Runbook: checkout (reserve-success) error-budget burn

Alerts: `checkout-burn-fast` (page), `checkout-burn-slow` (ticket). Dashboard: **saga-funnel**.

## Symptom

The checkout SLO — reserve success, `tickets_reserved / orders_created`, target 0.98 — is burning its
2% error budget. Fast (1h+5m windows, 14.4×) pages; slow (6h+30m, 6×) tickets. Both read the
`slo:availability_bad_ratio:ratio_rate*{slo="checkout"}` recording rules: orders are created but the
reserve that should follow is failing.

## Likely cause

- **Contention**: a hot ticket is being fought over and most reserves lose the optimistic-version
  race (see the `conflict-spike` alert / **saturation** board). This is the failure mode the SLO
  exists to catch.
- The tickets service is down, erroring, or slow enough that the orders→tickets reserve call times
  out.
- Inventory genuinely exhausted (see `inventory-exhausted`) — every reserve fails because there's
  nothing left to reserve.

## Checks

- **saga-funnel** board: watch the funnel collapse between `orders_created_total` and
  `tickets_reserved_total`. A widening gap is the burn.
- **saturation** board: available inventory + reservation conflicts. Exhausted inventory or a conflict
  spike points at the cause.
- tickets service health + logs: `kubectl -n tix logs deploy/tickets --tail=200` for reserve errors.

## Remediation

- If inventory is exhausted, that's expected SLO burn — confirm new inventory is listed; the burn
  clears as reserves start succeeding.
- If the tickets service is down or erroring, follow its health: restart/scale it and confirm reserves
  resume on the saga-funnel board.
- If it's pure contention with inventory available, the retry budget may need tuning — escalate to the
  reservation-saga owners (ADR-0007); this is a design pressure, not an outage.
