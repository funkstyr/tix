import { Metric } from "effect";

// Explicit business metrics for the tickets service (ADR-0009). Effect's MetricRegistry is
// process-global, so these are module constants; the OTLP metrics pipeline (otlpLayer) polls
// and exports them to Prometheus. Increment them inside the request/consumer spans so the
// values are attributable.

export const ticketsReservedTotal = Metric.counter("tickets_reserved_total", {
  description: "Ticket reservations that successfully claimed seats.",
  incremental: true,
});

export const reservationConflictsTotal = Metric.counter("tickets_reservation_conflicts_total", {
  description: "Reservations that exhausted the optimistic-version retry budget (ADR-0005).",
  incremental: true,
});

export const reservationsReleasedTotal = Metric.counter("tickets_reservations_released_total", {
  description: "Release events that restored seat inventory.",
  incremental: true,
});
