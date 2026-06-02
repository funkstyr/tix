# Runbook: payment (charge-success) error-budget burn

Alerts: `payment-burn-fast` (page), `payment-burn-slow` (ticket). Dashboard: **money-inventory**.

## Symptom

The payment SLO — charge success, `payments_succeeded / (succeeded + failed)`, target 0.99 — is
burning its 1% error budget. Fast (1h+5m, 14.4×) pages; slow (6h+30m, 6×) tickets. Reads the
`slo:availability_bad_ratio:ratio_rate*{slo="payment"}` recording rules: a meaningful share of charges
are failing.

## Likely cause

- A bad/placeholder Stripe key so every charge errors (dev ships `stripeKey` as a placeholder — see
  infra/pulumi/CLAUDE.md). This drives the budget straight down.
- Stripe-side trouble: declines, rate-limiting, or an outage. The `stripe-charge-error-rate` /
  `payment-failure-spike` alerts distinguish "Stripe's fault" from ours.
- A payments-code regression: a bad deploy mapping good charges to failures, or a broken idempotency
  path retrying into failures.

## Checks

- **money-inventory** board: payment success rate + charge latency. Confirm the failure fraction and
  whether latency is also elevated (points at Stripe slowness vs hard declines).
- Cross-check the `stripe-charge-error-rate` alert — if it's also firing, treat this as an external
  dependency problem (see [stripe-charge-error-rate.md](./stripe-charge-error-rate.md)).
- Payments logs: `kubectl -n tix logs deploy/payments --tail=200` for the charge error reasons.

## Remediation

- If charges fail on a placeholder key, set a real test key:
  `pulumi -C infra/pulumi config set --secret stripeKey sk_test_…`.
- If Stripe is the cause, follow the Stripe runbooks; there's little to do but wait out / fail over the
  dependency, but the alert correctly separates it from a tix bug.
- If a recent payments deploy correlates, roll it back and confirm `payments_succeeded_total` recovers
  on the money-inventory board.
