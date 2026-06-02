# Runbook: log ingestion absent

Alert: `logs-ingest-absent` (page). Dashboard: **logs-overview**.

## Symptom

Loki's line-ingest counter has disappeared from Prometheus:
`absent(rate(loki_distributor_lines_received_total[5m]))` returns a series (fires) for 10m. `absent()`
only fires when the metric itself is _gone_ — so this catches the logs pipeline going dark at the
metric level: Loki is down, no longer being scraped, or the distributor metric was renamed by an
image bump. The third pillar is blind while this fires — log-based alerts (`error-log-rate`) and the
logs-overview board have no data.

## Likely cause

- **Loki is down / crash-looping** (also expect `backend-down{job="loki"}`). Check Garage first —
  Loki depends on its S3 backend.
- **Prometheus isn't scraping Loki** — the `loki` scrape job is broken or Loki's `/metrics` is
  failing, so the counter series vanishes even though apps are still emitting.
- **Metric renamed on a Loki image bump** — `loki_distributor_lines_received_total` is image-version
  coupled (like the platform-o11y ingest panels). A bump can rename it; verify under the kind smoke.
- (Note: this does _not_ fire when apps merely stop shipping while Loki stays up — the counter then
  reports a flat rate, not an absent series. That case shows as a flat logs-overview board.)

## Checks

- **platform-o11y** board: `up{job="loki"}` and the "Tempo / Loki ingest" panel — is Loki up and is
  the loki-lines series present at all?
- `kubectl -n tix get pods` / `kubectl -n tix logs deploy/loki --tail=200` (and the otel-collector
  pod — it's the single egress to Loki).
- In Explore against Prometheus: query `loki_distributor_lines_received_total` directly — empty
  result confirms the metric is gone (vs. present-but-flat).

## Remediation

- If Loki is down: restore it (fix config / bump resources / restore Garage S3), then confirm the
  counter reappears and `up{job="loki"} == 1`.
- If the scrape is broken: fix the `loki` scrape target in `prometheus-backend.ts`.
- If a Loki image bump renamed the metric: update the alert expr (and the platform-o11y panel) to the
  new name and re-render.
- Confirm `rate(loki_distributor_lines_received_total[5m])` returns data and the logs-overview board
  shows live lines again.
