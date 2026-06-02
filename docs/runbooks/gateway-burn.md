# Runbook: gateway error-budget burn

Alerts: `gateway-burn-fast` (page), `gateway-burn-slow` (ticket). Dashboard: **edge-auth**.

## Symptom

The gateway is burning its 99% availability error budget faster than allowed. Fast (1h+5m windows,
14.4× budget) pages; slow (6h+30m, 6×) files a ticket. Both read the
`service:request_errors:ratio_rate*{service="gateway"}` recording rules.

## Likely cause

- A downstream the gateway fans out to (auth / tickets / orders) is erroring or timing out, and the
  gateway surfaces those as 5xx.
- A bad deploy of the gateway itself (auth fan-out misconfig, wrong downstream URL, panic on a route).
- Saturation: the gateway can't keep up with offered load (see the saturation board).

## Checks

- **edge-auth** board, gateway row: request rate, error ratio, and p95 latency. Confirm the error
  ratio is genuinely elevated and which status class dominates.
- Correlate with the **auth-deep-dive** / per-service boards — if a downstream is also red, fix that
  first (the gateway is just the messenger).
- Logs: `kubectl -n tix logs deploy/gateway --tail=200` for the failing routes / upstreams.

## Remediation

- If a downstream is the root cause, follow that service's runbook (e.g. [auth-burn.md](./auth-burn.md)).
- If a recent gateway deploy correlates with the burn, roll it back.
- If it's load, scale the gateway / the saturated downstream and confirm the error ratio recovers
  below the burn threshold on the edge-auth board.
