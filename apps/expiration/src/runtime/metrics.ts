import { Metric, MetricBoundaries } from "effect";

// Explicit business/technical metrics for the expiration worker (ADR-0009). Effect's
// MetricRegistry is process-global, so these are module constants; the OTLP metrics
// pipeline (otlpLayer) polls and exports them to Prometheus. Increment them inside the
// job span so the values are attributable to a single auto-cancel execution.

export const expirationsProcessedTotal = Metric.counter("expirations_processed_total", {
  description:
    "Auto-cancel jobs executed: an order.expired.v1 publish attempt for an expired Order.",
  incremental: true,
});

// Publishes that JetStream reported as duplicates — the at-least-once path firing when a
// BullMQ retry re-publishes an event whose first attempt already landed. A steady nonzero
// rate is healthy dedupe; a spike points at flapping workers or lost acks.
export const expiryDuplicatePublishTotal = Metric.counter("expiry_duplicate_publish_total", {
  description: "order.expired.v1 publishes deduped server-side by JetStream on a BullMQ retry.",
  incremental: true,
});

// expire-order job execution latency in milliseconds. Exponential buckets from 1ms doubling
// 12 times (~4s) cover a fast local publish through a slow NATS round-trip without
// hand-tuning per latency tier.
export const expiryJobLatencyMs = Metric.histogram(
  "expiry_job_latency_ms",
  MetricBoundaries.exponential({ start: 1, factor: 2, count: 12 }),
  "BullMQ expire-order job execution latency in milliseconds.",
);
