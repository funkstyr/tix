import { describe, expect, it } from "vitest";

import { moneyInventoryDashboardJson } from "./money-inventory.ts";

describe("moneyInventoryDashboardJson", () => {
  it("synthesizes a parseable dashboard with a stable uid and title", () => {
    const dashboard = JSON.parse(moneyInventoryDashboardJson());
    expect(dashboard.uid).toBe("money-inventory");
    expect(dashboard.title).toBe("Money & Inventory");
  });

  it("files under the Domain folder set", () => {
    const dashboard = JSON.parse(moneyInventoryDashboardJson());
    expect(dashboard.tags).toContain("domain");
    expect(dashboard.tags).toContain("money");
  });

  it("targets the money + inventory series (hand-rolled, ADR-0010)", () => {
    const json = moneyInventoryDashboardJson();
    for (const metric of [
      "order_value_cents_bucket",
      "order_value_cents_sum",
      "order_value_cents_count",
      "payments_succeeded_total",
      "payments_failed_total",
      "payment_charge_latency_ms_bucket",
      "tickets_reserved_total",
      "tickets_reservations_released_total",
    ]) {
      expect(json).toContain(metric);
    }
  });

  it("renders the order-value distribution as a heatmap", () => {
    expect(moneyInventoryDashboardJson()).toContain('"format": "heatmap"');
  });

  it("queries the provisioned prometheus datasource", () => {
    expect(moneyInventoryDashboardJson()).toContain('"uid": "prometheus"');
  });

  it("renders the stat panels as instant queries", () => {
    expect(moneyInventoryDashboardJson()).toContain('"instant": true');
  });
});
