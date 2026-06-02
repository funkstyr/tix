# Runbook: Stripe charge p95 latency over 3s

Alert: `stripe-charge-latency` (ticket). Dashboard: **money-inventory**.

## Symptom

The `payment:charge_latency_ms:p95_rate5m` recording rule — p95 of `payment_charge_latency_ms` — is
above 3000 ms. Charges are succeeding but slowly; Stripe is slow on the money path. Tickets rather
than pages: Stripe-slow is degraded, not down.

## Likely cause

- Stripe-side latency: elevated processing time, a regional slowdown, or retries inside the Stripe
  SDK.
- Network egress from the cluster to Stripe is degraded.
- The payments service is itself slow around the charge (a blocking call before/after `create`),
  inflating the measured charge latency.

## Checks

- **money-inventory** board: the Stripe charge-latency panel (p50/p95/p99). A high p99 with normal p50
  is tail/retry behaviour; a whole-distribution shift is a broad slowdown.
- Cross-check `stripe-charge-error-rate` — slow **and** failing points at a Stripe incident.
- Payments logs: `kubectl -n tix logs deploy/payments --tail=200` for slow-charge timing / SDK retry
  logs.

## Remediation

- If Stripe is the source, check Stripe status; there's no tix-side fix beyond confirming we aren't
  adding our own latency around the call. The ticket tracks it until p95 recovers under 3s.
- If the payments service is adding latency around the charge, profile and move the blocking work off
  the charge path; confirm p95 drops on the board.
