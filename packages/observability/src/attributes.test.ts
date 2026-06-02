import { describe, expect, it } from "vitest";

import { SpanAttr, domainAttributes } from "./attributes.js";

describe("SpanAttr", () => {
  it("namespaces domain identity under tix.* and reuses OTel conventions", () => {
    expect(SpanAttr.orderId).toBe("tix.order.id");
    expect(SpanAttr.ticketId).toBe("tix.ticket.id");
    expect(SpanAttr.buyerId).toBe("tix.buyer.id");
    expect(SpanAttr.quantity).toBe("tix.order.quantity");
    expect(SpanAttr.valueCents).toBe("tix.order.value_cents");
    expect(SpanAttr.messageId).toBe("messaging.message.id");
    expect(SpanAttr.destination).toBe("messaging.destination.name");
    expect(SpanAttr.httpMethod).toBe("http.request.method");
    expect(SpanAttr.httpRoute).toBe("http.route");
  });
});

describe("domainAttributes", () => {
  it("drops undefined values so a span never carries an empty key", () => {
    expect(
      domainAttributes({ [SpanAttr.orderId]: "o1", [SpanAttr.buyerId]: undefined }),
    ).toEqual({ [SpanAttr.orderId]: "o1" });
  });

  it("keeps falsy-but-defined values (0, false, empty string)", () => {
    expect(domainAttributes({ [SpanAttr.quantity]: 0, [SpanAttr.valueCents]: 0 })).toEqual({
      [SpanAttr.quantity]: 0,
      [SpanAttr.valueCents]: 0,
    });
  });
});
