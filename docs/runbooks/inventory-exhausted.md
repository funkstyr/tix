# Runbook: ticket inventory exhausted

Alert: `inventory-exhausted` (page). Dashboard: **saturation**.

## Symptom

The `inventory:available:min` recording rule — `min(tickets_available_inventory)` — has hit zero.
Every reserve now fails for lack of inventory: lost revenue, and the `checkout` SLO will burn.

## Likely cause

- Genuine sell-out: demand consumed all listed inventory. Expected, but worth knowing immediately.
- Inventory not being replenished: sellers' listings aren't landing (tickets service ingest broken),
  so available inventory drains to zero and isn't topped up.
- A leak: reservations aren't being released on expiry/cancel, so seats are held but never restored
  (watch reserved-vs-released churn converging on the money-inventory board).

## Checks

- **saturation** board: available inventory (at zero) and the reserved-vs-released churn. Converging
  reserve/release means a release path is broken, not a true sell-out.
- **saga-funnel** board: reserves failing confirms the downstream impact.
- tickets service health + logs: `kubectl -n tix logs deploy/tickets --tail=200` for listing/ingest
  or release errors.

## Remediation

- True sell-out → no action beyond confirming; the alert clears when new inventory is listed.
- Broken ingest → restore the tickets listing path and confirm available inventory climbs off zero.
- Broken release → confirm the expiration/cancel → `order.*` → release flow (see
  [saga-stall.md](./saga-stall.md) for the outbox/NATS checks); released seats should restore
  inventory.
