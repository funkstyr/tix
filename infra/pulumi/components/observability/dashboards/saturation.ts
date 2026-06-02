import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";

import { tsPanel } from "./_shared.ts";

// Saturation board (ADR-0011 Tier 1; predictive panels added ADR-0012 Tier 1), Domain folder.
// Gauges are the USE/saturation counterpart to the RED boards: queue depth, outbox lag, available
// inventory, pending orders — the levels that lead the saga-stall alert. All are hand-rolled
// `Effect.Metric` gauges (last value), graphed as timeseries so trend, not just instant, is visible.
//
// The two `predict_linear` panels project the levels that build silently to a cliff (outbox lag, the
// expiration queue) two hours out, so backpressure is visible before the stall — the board companion
// to the `outbox-lag-projected` / `queue-depth-projected` capacity alerts (alert-rules.ts).

const DASHBOARD_UID = "saturation";

// Project 2h ahead (7200s) from a 30m trend — the same horizon the capacity alerts fire on.
const PROJECT_SECONDS = 2 * 3600;
const TREND_WINDOW = "30m";

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
    tsPanel("Outbox lag — now vs projected (2h)", "short", { h: 8, w: 12, x: 0, y: 16 }, [
      { expr: "outbox:lag:max", legend: "now (max)" },
      {
        expr: `predict_linear(outbox:lag:max[${TREND_WINDOW}], ${PROJECT_SECONDS})`,
        legend: "projected +2h",
      },
    ]),
    tsPanel("Queue depth — now vs projected (2h)", "short", { h: 8, w: 12, x: 12, y: 16 }, [
      { expr: "expiration_queue_depth", legend: "now" },
      {
        expr: `predict_linear(expiration_queue_depth[${TREND_WINDOW}], ${PROJECT_SECONDS})`,
        legend: "projected +2h",
      },
    ]),
  ]) {
    dashboard = dashboard.withPanel(panel);
  }

  return JSON.stringify(dashboard.build(), null, 2);
}
