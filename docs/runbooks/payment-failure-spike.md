# Runbook: payment failure step-change vs 30m ago

Alert: `payment-failure-spike` (warning). Dashboard: **money-inventory**.

## Symptom

The current 5m payment-failure rate is more than double the rate 30m ago
(`rate(payments_failed_total[5m]) > 2 * …[5m] offset 30m`) and above a small absolute floor. A
change-detector: it catches a sharp rise in failures even before the absolute
`stripe-charge-error-rate` (>5%) threshold trips. Warning severity — it's a leading signal.

## Likely cause

- The onset of a Stripe incident or a wave of declines (a campaign attracting more bad cards, a BIN
  range being declined).
- A payments deploy ~30m ago that began mapping some charges to failures.
- A downstream dependency (the `order.*` event feeding payments) changing shape so charges error.

## Checks

- **money-inventory** board: the payment success-rate panel — confirm the rise and read its slope.
- Use the 30m onset the alert implies to line up against deploys / config changes (`kubectl -n tix
rollout history deploy/payments`).
- Payments logs around the step time: `kubectl -n tix logs deploy/payments --tail=200`.

## Remediation

- If a deploy correlates, roll it back.
- If it's the leading edge of a Stripe problem, expect `stripe-charge-error-rate` to follow; pre-empt
  by following [stripe-charge-error-rate.md](./stripe-charge-error-rate.md).
- Confirm the failure rate settles back toward its prior baseline on the board; the warning clears
  when the step-change relation no longer holds.
