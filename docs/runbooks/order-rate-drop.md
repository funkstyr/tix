# Runbook: order creation rate dropped to the floor

Alert: `order-rate-drop` (page). Dashboard: **saturation**.

## Symptom

The `order:created:rate10m` recording rule — `sum(rate(orders_created_total[10m]))` — has fallen below
the floor (0.01/s) for a sustained window. This is the "revenue stopped" alert: it catches outages the
technical alerts miss, because a fully-broken front door produces _no_ orders rather than _failing_
ones. Pages, with a long `for` (15m) so a brief lull doesn't trip it.

## Likely cause

- A front-of-funnel outage: the gateway, web SPA, or auth is down, so buyers never reach order
  creation (the technical alerts for those should also fire — cross-check).
- The orders service itself is down or rejecting every create.
- Genuine zero traffic: in dev, the k6 load generator is off (`loadgenEnabled` unset) or finished, so
  no orders flow. Confirm before treating as an incident.

## Checks

- **saturation** board (and **saga-funnel**): confirm `orders_created_total` has actually flatlined,
  not just dipped.
- Are upstream alerts firing? `backend-down`, `probe-failure`, gateway/auth burns — a correlated
  upstream outage explains the drop and is the thing to fix.
- In dev: is the load generator running? `kubectl -n tix get deploy load-generator` — if it's absent
  or scaled to zero, the drop is expected, not an incident.

## Remediation

- Fix the correlated upstream outage (follow its runbook); orders resume once the funnel is reachable.
- If orders itself is down, restart/scale it and confirm the rate climbs back above the floor.
- In dev with load-gen off, this is expected — silence it by running the generator, or accept it as a
  dev-only artifact (alerting is gated by `alertingEnabled`).
