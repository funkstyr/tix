import { Metric, MetricBoundaries } from "effect";

// Explicit business metrics for the orders service (ADR-0009). Effect's MetricRegistry is
// process-global, so these are module constants; the OTLP metrics pipeline (otlpLayer)
// polls and exports them to Prometheus. Increment them inside the request/consumer spans
// so the values are attributable.

export const ordersCreatedTotal = Metric.counter("orders_created_total", {
  description: "Orders successfully created.",
  incremental: true,
});

export const reservationConflictsTotal = Metric.counter("reservation_conflicts_total", {
  description: "Order creations that lost the inventory reservation race.",
  incremental: true,
});

// Order total value in cents. Exponential buckets from $1 (100c) doubling 16 times (~$1.3M)
// cover the resale range with a long tail without hand-tuning per price tier.
export const orderValueCents = Metric.histogram(
  "order_value_cents",
  MetricBoundaries.exponential({ start: 100, factor: 2, count: 16 }),
  "Order total value in cents.",
);

export const outboxLagGauge = Metric.gauge("orders_outbox_lag", {
  description: "Un-relayed outbox rows (sentAt IS NULL).",
});

export const pendingOrdersGauge = Metric.gauge("orders_pending_count", {
  description: "Orders in the `created` state awaiting reserve/pay/expire.",
});
