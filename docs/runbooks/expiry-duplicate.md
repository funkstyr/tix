# Runbook: expiration duplicate-publish spike

Alert: `expiry-duplicate-publish-spike` (warning). Dashboard: **expiration-worker**.

## Symptom

`rate(expiry_duplicate_publish_total[5m]) > 0` is sustained — the expiration worker's at-least-once
path re-published an event that JetStream then reported as a duplicate. The dedupe is working (no
double-effect), but a sustained rate means the worker keeps re-trying publishes.

## Likely cause

- The worker publishes, doesn't see the ack in time, and re-publishes; JetStream's message-dedupe
  window catches the repeat. Often a sign of slow/flaky NATS acks or the worker crash-looping after
  publish-before-commit.
- A redelivery storm: BullMQ re-running expiration jobs (job not acked, worker restarts) so the same
  `order.expired` is published repeatedly.

## Checks

- **expiration-worker** board: job throughput / processed counts vs the duplicate-publish rate — a
  duplicate rate that scales with redeliveries points at job acking.
- NATS / JetStream health: are publish acks slow? Is the stream healthy?
- Worker logs: `kubectl -n tix logs deploy/expiration --tail=200` (or the worker pod) for restart
  loops or publish-retry log lines.

## Remediation

- If the worker is crash-looping (publishing before committing job state), fix the ordering so the
  job is acked atomically with the publish, then the duplicates stop.
- If NATS acks are slow, address the JetStream/NATS health; the retries (and dedupe hits) subside.
- This is a warning, not a page: the inbox/dedupe guarantees correctness — the goal is to stop the
  wasted re-publishing, not to prevent double-processing.
