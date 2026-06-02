// Span attribute vocabulary (ADR-0011 Tier 1). One reviewed module so every handler,
// consumer, and job names the same keys — domain identity under `tix.*`, transport/HTTP
// under the OTel semantic conventions. These are SPAN attributes only: high-cardinality
// identifiers (order/ticket/buyer ids) are safe on a trace and must never become metric
// labels, so this module is imported by span sites, never by `*-metrics.ts`.

export const SpanAttr = {
  // Domain identity — tix namespace, unbounded cardinality, span-only.
  orderId: "tix.order.id",
  ticketId: "tix.ticket.id",
  buyerId: "tix.buyer.id",
  sellerId: "tix.seller.id",
  paymentId: "tix.payment.id",
  reservationStatus: "tix.reservation.status",
  quantity: "tix.order.quantity",
  valueCents: "tix.order.value_cents",

  // OTel semantic conventions — reuse the standard keys so Tempo/Grafana recognise them.
  messageId: "messaging.message.id",
  destination: "messaging.destination.name",
  httpMethod: "http.request.method",
  httpRoute: "http.route",
  httpStatus: "http.response.status_code",
} as const;

export type SpanAttrValue = string | number | boolean;

// Builds a span-attribute record, dropping `undefined` values (a span must never carry an
// empty key) while keeping falsy-but-defined ones (`0`, `false`, `""` are real values).
export function domainAttributes(
  record: Readonly<Record<string, SpanAttrValue | undefined>>,
): Record<string, SpanAttrValue> {
  const out: Record<string, SpanAttrValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
