# Runbook: Pod OOMKilled

Alert: `pod-oomkilled` (page). Dashboard: **cluster-use**.

## Symptom

`kube_pod_container_status_last_terminated_reason{reason="OOMKilled",namespace="tix"} > 0` — a tix
container hit its memory limit and was killed by the kernel OOM killer. This is the exact failure
that masquerades as "the saga stalled": the worker didn't hang, it died and restarted, dropping
in-flight work.

## Likely cause

- Memory limit set too low for the workload.
- A memory leak or an unbounded in-memory buffer (e.g. loading a large result set).
- A traffic/load spike pushing legitimate usage over the limit.

## Checks

- **cluster-use** board: "Pod restarts + OOMKills" panel (which pod) and the "Pod memory working
  set" panel (was it trending up to the limit?).
- `kubectl -n tix describe pod <pod>` — `Last State: Terminated, Reason: OOMKilled` and the limit.
- The service's logs just before the restart for what it was doing.

## Remediation

- Raise the container's memory limit if the usage is legitimate.
- Fix the leak / bound the buffer if memory grows unboundedly.
- **Reconcile dropped work**: an OOMKilled consumer may have lost an un-acked message (JetStream will
  redeliver) or an in-flight HTTP request (the client retries) — verify the affected saga completed.
- Confirm no further OOMKills on the board.
