# Runbook: synthetic probe failing

Alert: `probe-failure` (page). Dashboard: **synthetics**.

## Symptom

The always-on blackbox exporter couldn't get a 2xx from a tix HTTP endpoint: `probe_success < 1`.
One alert fires per failing target (the probed URL is the `instance` label, templated into the
summary). This is the outside-in counterpart to `backend-down` — it probes the services the way an
external client would, so it catches a broken ingress→service path even while the process still
reports itself `up`.

## Likely cause

- The probed service is down, crash-looping, or not yet Ready (OOMKilled, bad config, failed
  migration) — its `/health` or `/ready` returns non-2xx or nothing.
- The service is `up` but its HTTP surface is wedged (deadlock, exhausted pool, dependency timeout),
  so the in-process self-scrape stays green while the outside-in probe fails.
- The blackbox exporter itself can't reach the target (DNS, NetworkPolicy, Service selector drift).

## Checks

- **synthetics** board: the probe-success / probe-duration / HTTP-status panels show which
  `instance` dropped and for how long — read the failing URL off the legend.
- Service logs for the failing instance: `kubectl -n tix logs deploy/<service> --tail=200` (the host
  in the URL is the service name, e.g. `http://orders:4003/ready` → `deploy/orders`).
- Pod status: `kubectl -n tix get pods` then `kubectl -n tix describe pod <pod>` (OOMKilled /
  CrashLoopBackOff / pending PVC / failed readiness).
- If every target fails at once, suspect the blackbox exporter, not the services:
  `kubectl -n tix logs deploy/blackbox-exporter`.

## Remediation

- Restart / fix the failing service (correct the config, bump resources if OOMKilled, unblock the
  stuck dependency).
- If only `/ready` fails while `/health` passes, the process is alive but a dependency it gates on
  (DB, NATS, downstream service) is unavailable — chase that dependency.
- If the blackbox exporter is the root cause, restore it; probes recover on the next scrape.
- Confirm `probe_success == 1` for every instance on the synthetics board.
