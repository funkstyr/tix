# Runbook: reservation saga stalled at pay

Alert: `saga-stall` (page). Dashboard: **saga-funnel**.

## Symptom

Orders keep being created (`rate(orders_created_total[10m]) > 0.05`) while
`rate(payments_succeeded_total[10m])` stays flat (`< 0.01`). The reservation saga is wedged between
reserve and pay — buyers reserve but nothing settles.

## Likely cause

- Payments service down, or a bad/placeholder Stripe key so every charge errors (dev ships
  `stripeKey` as a placeholder — see infra/pulumi/CLAUDE.md).
- The `order.*` event the payments service consumes isn't reaching it: NATS JetStream stream missing,
  consumer wedged, or the outbox relay backed up so `order.created` never publishes.
- Payments is up but failing every charge (declines, network errors to Stripe).

## Checks

- **saga-funnel** board: watch the funnel collapse at the pay step — `orders_created_total` and
  `tickets_reserved_total` climbing while `payments_succeeded_total` is flat confirms the stall.
- **saturation** board: the **queue-depth** + **outbox-lag** panels. A growing outbox lag means
  `order.created` events are stuck in the outbox and never reaching payments — that's a relay/NATS
  problem, not a Stripe problem.
- Payments health + logs: `kubectl -n tix logs deploy/payments --tail=200` for charge errors.

## Remediation

- If outbox lag is the cause: unblock the relay / NATS (confirm the `ORDERS` stream + payments
  consumer exist), and the backlog drains.
- If payments is down, restart/scale it.
- If charges are failing on a placeholder key, set a real `sk_test_…`:
  `pulumi -C infra/pulumi config set --secret stripeKey sk_test_…`.
- Confirm `payments_succeeded_total` resumes on the saga-funnel board.
