import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";

import { tsPanel } from "./_shared.ts";

// Saturation board (ADR-0011 Tier 1), Domain folder. Gauges are the USE/saturation counterpart
// to the RED boards: queue depth, outbox lag, available inventory, pending orders — the levels
// that lead the saga-stall alert. All are hand-rolled `Effect.Metric` gauges (last value),
// graphed as timeseries so trend, not just instant, is visible.

const DASHBOARD_UID = "saturation";

export function saturationDashboardJson(): string {
  let dashboard = new DashboardBuilder("Saturation & Backpressure")
    .uid(DASHBOARD_UID)
    .description(
      "USE-style saturation levels: queue depth, outbox lag, available inventory, pending orders (ADR-0011).",
    )
    .tags(["domain", "saturation"])
    .refresh("30s");

  for (const panel of [
    tsPanel("Expiration queue depth", "short", { h: 8, w: 12, x: 0, y: 0 }, [
      { expr: "expiration_queue_depth", legend: "waiting+delayed+active" },
    ]),
    tsPanel("Outbox lag (un-relayed rows)", "short", { h: 8, w: 12, x: 12, y: 0 }, [
      { expr: "orders_outbox_lag", legend: "orders" },
      { expr: "tickets_outbox_lag", legend: "tickets" },
      { expr: "payments_outbox_lag", legend: "payments" },
    ]),
    tsPanel("Available ticket inventory", "short", { h: 8, w: 12, x: 0, y: 8 }, [
      { expr: "tickets_available_inventory", legend: "available" },
    ]),
    tsPanel("Pending orders", "short", { h: 8, w: 12, x: 12, y: 8 }, [
      { expr: "orders_pending_count", legend: "created" },
    ]),
  ]) {
    dashboard = dashboard.withPanel(panel);
  }

  return JSON.stringify(dashboard.build(), null, 2);
}
