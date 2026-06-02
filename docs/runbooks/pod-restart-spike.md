# Runbook: Pod restart spike

Alert: `pod-restart-spike` (warning). Dashboard: **cluster-use**.

## Symptom

`sum(increase(kube_pod_container_status_restarts_total{namespace="tix"}[15m])) by (pod) > 3` — a tix
pod restarted more than 3 times in 15 minutes: a CrashLoop. The service is flapping, so its RED
metrics and any saga it drives are intermittently unavailable.

## Likely cause

- A bad deploy (broken config, missing env/secret, failed migration on boot).
- A failing readiness/liveness dependency (DB/NATS/Redis unreachable → liveness kills the pod).
- Repeated OOMKills (see `pod-oomkilled.md`) — check the OOM panel to disambiguate.

## Checks

- **cluster-use** board: "Pod restarts + OOMKills" — which pod, and is it OOM or not.
- `kubectl -n tix describe pod <pod>` — restart count, last state, and the kill reason.
- `kubectl -n tix logs <pod> --previous` — the crash output from the prior container.
- **datastore-health** / **platform-o11y**: is a dependency (PG/Redis/NATS/an LGTM backend) down?

## Remediation

- If it's a bad deploy, roll back to the last good image tag.
- If a dependency is down, restore it (the pod recovers once liveness passes).
- If OOM, follow `pod-oomkilled.md`.
- Confirm the restart rate settles to zero.
