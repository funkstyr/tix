# Runbook: observability backend down

Alert: `backend-down` (page). Dashboard: **platform-o11y**.

## Symptom

A scrape target's `up` series fell below 1:
`up{job=~"otel-collector|tempo|loki|prometheus|garage"} < 1`. One alert fires per down target (the
`job` label is templated into the summary). This is the only app-independent alert — it reads
Prometheus's self-scrape, not OTLP-pushed series.

## Likely cause

- The named backend pod is down, crash-looping, or not yet Ready (OOMKilled, bad config, PVC issue).
- Garage (object store) down → Tempo/Loki lose their S3 backend and can fail their own health.
- Prometheus can reach the network but the target's `/metrics` endpoint is failing.

## Checks

- **platform-o11y** board: the backend-up panels show which target(s) dropped and for how long.
- Pod status: `kubectl -n tix get pods` then `kubectl -n tix describe pod <pod>` for the down job
  (look for OOMKilled / CrashLoopBackOff / pending PVC).
- Logs: `kubectl -n tix logs <pod> --tail=200`.
- If Tempo/Loki are down, check Garage first — they depend on its S3.

## Remediation

- Restart / fix the down backend (correct the config, bump resources if OOMKilled, fix the PVC).
- If Garage is the root cause, restore it; Tempo/Loki recover once S3 is reachable.
- Note: with a backend down, the telemetry feeding the _other_ alerts may be degraded — treat
  backend-down as a meta-incident and restore observability before trusting the domain boards.
- Confirm `up == 1` for every target on the platform-o11y board.
