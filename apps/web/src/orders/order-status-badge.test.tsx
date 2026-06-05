import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OrderRecord } from "@tix/contracts/orders";

import { ORDER_STATUS_VARIANT, OrderStatusBadge } from "./order-status-badge";

describe("OrderStatusBadge", () => {
  it("maps each status to its variant", () => {
    expect(ORDER_STATUS_VARIANT).toEqual({
      created: "secondary",
      awaiting_payment: "default",
      complete: "success",
      cancelled: "outline",
      expired: "destructive",
    });
  });

  it("renders the status text under the order-status test id", () => {
    const html = renderToStaticMarkup(<OrderStatusBadge status={"complete" as OrderRecord["status"]} />);
    expect(html).toContain('data-testid="order-status"');
    expect(html).toContain("complete");
  });
});
