# Runbook: Stripe charge error-rate over 5%

Alert: `stripe-charge-error-rate` (page). Dashboard: **money-inventory**.

## Symptom

`payments_failed / (payments_succeeded + payments_failed)` over 5m is above 5%. The threshold sits
above the k6 generator's induced-decline baseline and far above real Stripe's own <0.1% decline rate,
so this is the external money dependency clearly failing — distinct from the `saga-stall` heuristic.

## Likely cause

- Stripe-side trouble: an outage, elevated declines, or rate-limiting on the `paymentIntents.create`
  path.
- A bad/placeholder Stripe key (dev ships `stripeKey` as a placeholder — every charge errors at
  Stripe; see infra/pulumi/CLAUDE.md).
- A payments-code regression sending malformed requests Stripe rejects.

## Checks

- **money-inventory** board: payment success rate + charge latency. If latency is also high, see
  `stripe-charge-latency`; if errors spike without latency, it's hard declines/rejections.
- Is `payment-failure-spike` also firing? A step-change pins the onset time.
- Payments logs: `kubectl -n tix logs deploy/payments --tail=200` — group by Stripe error type
  (card_declined vs rate_limit vs api_error). (Per-reason metric tagging is out of scope for ADR-0012
  Tier 1; the logs are the source of truth for the reason.)

## Remediation

- Placeholder key → set a real test key:
  `pulumi -C infra/pulumi config set --secret stripeKey sk_test_…`.
- Stripe outage/rate-limit → check Stripe status; back off and retry per Stripe guidance. There's no
  tix-side fix beyond confirming we aren't hammering a rate-limited endpoint.
- Code regression → roll back the correlating payments deploy and confirm the error-rate falls below
  5% on the board.
