# Runbook: JetStream redelivery spike

Alert: `jetstream-redelivery-spike` (warning). Dashboard: **datastore-health**.

## Symptom

`max(nats_consumer_num_redelivered) > 100` — JetStream is redelivering a lot of messages. A
redelivery means a consumer received a message but didn't ack it (it nacked, errored, or its
ack-wait timed out), so JetStream redelivers. Sustained redelivery burns throughput and usually
precedes consumer lag.

## Likely cause

- A handler throwing on certain messages (a poison message, or a downstream dependency down).
- Ack-wait too short for a slow handler, so messages time out before they finish.
- The consumer crashing mid-processing (check `cluster-use`).

## Checks

- **datastore-health** board: "JetStream redelivered + ack pending" panel.
- The consuming service's logs for repeated handler errors on the same subject/payload.
- `nats consumer report <STREAM>` for redelivery counts and ack-wait config.
- The inbox dedupe table (ADR-0005) — repeated redelivery of an already-processed message should be
  deduped, so confirm the inbox is doing its job (no double side-effects).

## Remediation

- Fix the erroring handler; if it's a poison message, route it to a DLQ or skip-and-log.
- Raise the consumer's ack-wait if the handler is legitimately slow.
- Confirm redelivery falls back to baseline.
