# Runbook: JetStream consumer falling behind

Alert: `jetstream-consumer-lag` (ticket). Dashboard: **datastore-health**.

## Symptom

`max(nats_consumer_num_pending) > 1000` — a JetStream consumer has over 1000 messages waiting to be
delivered/acked. This is the **inbox** side ADR-0011's outbox gauges can't see: the producer relayed
the events, but a consumer service isn't keeping up, so domain events (reservations, payments,
expirations) are processed late.

## Likely cause

- A consumer service is down, slow, or crash-looping (check `cluster-use` for restarts/OOMKills).
- A handler is erroring and nacking, so messages requeue (see `jetstream-redelivery-spike.md`).
- A traffic spike outpacing the consumer's throughput.

## Checks

- **datastore-health** board: "JetStream consumer pending" (and redelivered / ack-pending).
- Which consumer? `nats consumer report <STREAM>` (or the NATS `:8222/jsz?consumers=true` JSON).
  Streams are `TICKETS` / `ORDERS` / `PAYMENTS`.
- **cluster-use** board: is the consuming service OOMKilling or restarting?
- The service's own logs (`kubectl -n tix logs deploy/<service>`).

## Remediation

- Restore / scale the lagging consumer service.
- If a handler is erroring, fix it so messages ack instead of redelivering.
- Once the consumer recovers, pending should drain back toward zero — confirm on the board.
