import { Metric, MetricBoundaries } from "effect";

// Explicit business/technical metrics for the payments service (ADR-0009). Effect's
// MetricRegistry is process-global, so these are module constants; the OTLP metrics
// pipeline (otlpLayer) polls and exports them to Prometheus. Increment them inside the
// request span so the values are attributable to a charge attempt.

export const paymentsSucceededTotal = Metric.counter("payments_succeeded_total", {
  description: "Payments where the Stripe charge succeeded and a Payment row was recorded.",
  incremental: true,
});

export const paymentsFailedTotal = Metric.counter("payments_failed_total", {
  description: "Charge attempts that did not result in a succeeded payment (intent not succeeded).",
  incremental: true,
});

// Stripe PaymentIntent round-trip latency in milliseconds. Exponential buckets from 10ms
// doubling 12 times (~40s) cover a fast confirm through a slow network call without
// hand-tuning per latency tier.
export const paymentChargeLatencyMs = Metric.histogram(
  "payment_charge_latency_ms",
  MetricBoundaries.exponential({ start: 10, factor: 2, count: 12 }),
  "Stripe PaymentIntent confirmation latency in milliseconds.",
);
