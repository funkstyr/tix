# Runbook: latency-SLO burn (gateway / auth / payment p95)

Alerts: `gateway-latency-burn-fast`/`-slow`, `auth-latency-burn-fast`/`-slow`,
`payment-latency-burn-fast`/`-slow` (fast = page, slow = ticket). Dashboards: **edge-auth** (gateway,
auth), **money-inventory** (payment).

## Symptom

A latency SLO is burning its budget — too large a share of requests are slower than the bound. The
objectives:

| SLO     | Bound (p95) | Budget | Bucket metric                        |
| ------- | ----------- | ------ | ------------------------------------ |
| gateway | ≤ 500 ms    | 5%     | `gateway_request_duration_ms_bucket` |
| auth    | ≤ 300 ms    | 5%     | `auth_request_duration_ms_bucket`    |
| payment | ≤ 1000 ms   | 5%     | `payment_charge_latency_ms_bucket`   |

Each burn reads `slo:latency_violation:ratio_rate*{slo="<name>-latency"}` — the fraction of requests
exceeding the bound — over the same fast (1h+5m) / slow (6h+30m) windows as the availability burns.
Latency burn is a quantile-violation fraction, not an error ratio (ADR-0012 Tier 1).

## Likely cause

- Saturation: the service can't keep up with offered load (see the **saturation** board) — queueing
  inflates the tail.
- A slow downstream the request fans out to (gateway → auth/tickets/orders; payment → Stripe).
- A bad deploy that added a slow path (an N+1 query, a synchronous call that should be async).

## Checks

- The deep-linked board's latency row: confirm p95 is genuinely above the bound and for how long. The
  exemplar latency panels (edge-auth) jump to a slow trace in Tempo.
- Correlate with the availability burn for the same service — if both fire, it's likely saturation or
  a down downstream, not pure latency.
- For payment latency, cross-check `stripe-charge-latency`: if Stripe's p95 is the cause, the bound
  blowout is external (see [stripe-charge-latency.md](./stripe-charge-latency.md)).

## Remediation

- If load-driven, scale the service / the saturated downstream and confirm p95 drops back under the
  bound on the board.
- If a deploy correlates, roll it back.
- If a downstream is slow, follow that dependency's runbook; the latency SLO is the messenger.
