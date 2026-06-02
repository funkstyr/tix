# Runbook: error-log rate spike

Alert: `error-log-rate` (warning). Dashboard: **logs-overview**.

## Symptom

Error-and-above logs are spiking across services:
`sum(rate({service_name=~".+"} | severity_number >= 17 [5m])) > 1` (errors/sec) sustained for 5m.
This is a **leading** indicator — error logs usually spike before the RED / burn-rate alerts
degrade, so treat it as an early heads-up, not a confirmed outage. (`severity_number >= 17` is the
OTLP ERROR/FATAL range; Effect sets it on every log record, so it's the ground-truth level.)

## Likely cause

- A real fault forming: a downstream dependency wobbling (Stripe, NATS, Postgres, Redis), a bad
  deploy, or a hot code path throwing.
- One noisy service drowning the rest (check the by-service panel before assuming a global issue).
- A retry storm — the same failure logged once per attempt amplifies the rate.

## Checks

- **logs-overview** board: the "Log volume by service" + "by level" panels show _which_ service and
  _which_ level spiked; the "Recent errors" stream shows the actual lines.
- Click a recent-error line → **View trace** (the `trace_id` derived field) to jump to the failing
  request in Tempo and see where in the saga it broke.
- Cross-check the **saga-funnel** / **money-inventory** / **datastore-health** boards: is a RED or
  burn alert about to trip? If so this was the early warning working as intended.
- Narrow with LogQL in Explore: `sum by (service_name) (rate({service_name=~".+"} | severity_number >= 17 [5m]))`.

## Remediation

- If it's a genuine fault, follow the runbook for whatever the traces point at (saga-stall,
  stripe-charge-error-rate, a datastore alert, …) — this alert's job is to send you there early.
- If it's log noise (one over-chatty path, a retry loop logging each attempt), fix the log level or
  the retry logging at the source rather than raising the threshold — `LOG_LEVEL` controls verbosity
  per service, but error-level noise usually signals a real bug to quiet at the cause.
- Confirm the rate falls back under 1/s on the logs-overview error-rate panel once resolved.
