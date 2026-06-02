# Runbook: PersistentVolumeClaim nearly full

Alert: `pvc-nearly-full` (ticket). Dashboard: **cluster-use**.

## Symptom

`kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes > 0.85` — a PVC is over 85%
full. Postgres, NATS JetStream, Prometheus, Tempo's WAL, and the collector queue all run on PVCs; a
full one means write failures and a wedged StatefulSet (lost data on the data stores).

> **Dev-dormant on kind.** `kubelet_volume_stats_*` is emitted by the kubelet for CSI-backed volumes;
> kind's `local-path` provisioner (hostPath-backed) reports none, so this alert/panel is empty on the
> kind smoke. It is prod-meaningful — a real cluster's CSI driver (EBS/PD/etc.) populates the series —
> the same dev-dormant posture as `pg-replication-lag` (no replicas in dev).

## Likely cause

- Organic growth (DB tables, JetStream streams, Prometheus TSDB) toward the volume size.
- Retention not bounding a store (Prometheus/Tempo/Loki retention is set, but a PVC can still fill
  if the window is large relative to the volume).
- A runaway: a log/stream flood, or a queue backing up on the collector PVC.

## Checks

- **cluster-use** board: "PVC utilization" panel — which `persistentvolumeclaim`.
- `kubectl -n tix get pvc` and `kubectl -n tix describe pvc <name>`.
- For Prometheus/Tempo/Loki, cross-check the retention config (ADR-0011 Tier 3 knobs in index.ts).

## Remediation

- Expand the PVC (`kubectl -n tix edit pvc <name>` if the StorageClass allows volume expansion).
- Prune: tighten retention on the store, or delete reclaimable data.
- For a runaway, stop the source (e.g. a log flood) then reclaim.
- This is a ticket — act before it hits 100%. Confirm utilization trends back down.
