# Runbook: JetStream lost messages

Alert: `jetstream-lost-messages` (page). Dashboard: **datastore-health**.

## Symptom

`sum(jetstream_stream_lost_messages) > 0` — JetStream reports messages it can no longer deliver: a
stream's persisted messages were lost (storage corruption, a too-aggressive retention/limit policy
discarding un-acked messages, or a disk failure on the NATS PVC). This is **data loss** — a domain
event (a reservation, payment, or expiration) has vanished, so the saga that depended on it stalls.

> **Dormant until the exporter surfaces it.** `prometheus-nats-exporter` v0.17.3 does not emit a
> `jetstream_stream_lost_messages` series, so this alert reads a metric that isn't produced today and
> stays silent (noDataState OK). It is wired and ready, and activates automatically if a future
> exporter/NATS build exposes the series. Until then, detect lost messages manually via
> `nats stream info <STREAM>` (the `State.Lost` block).

## Likely cause

- The NATS PVC filled or its disk failed (check `cluster-use` → PVC utilization).
- A stream limit (max-msgs / max-bytes / max-age) discarded messages before consumers acked them.
- File-store corruption after an unclean NATS restart.

## Checks

- **datastore-health** board: "JetStream lost messages" panel — which stream.
- `nats stream report` / `nats stream info <STREAM>` — `lost`, limits, and storage usage.
- **cluster-use** board: NATS PVC fill and any NATS pod restarts/OOMKills.
- NATS logs (`kubectl -n tix logs statefulset/nats`).

## Remediation

- **This is a paging data-loss event** — treat it as an incident.
- Stop further loss first: expand the NATS PVC / relax the limit that's discarding messages.
- Reconcile affected aggregates: identify Orders/Tickets/Payments whose driving event was lost and
  replay or repair them from the source-of-truth tables (the outbox rows on the producer side).
- Confirm `lost` stops climbing, then root-cause the storage/limit issue before closing.
