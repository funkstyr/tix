import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";

import { redRow } from "./red-row.ts";

// Edge + auth RED board (ADR-0010), Services folder. The gateway and auth services emit
// hand-rolled RED histograms tagged by `op`; this board reuses the `redRow` factory for both,
// one row each. Reads the explicit `Effect.Metric` series only (not span-derived), so it does
// not double-count against the spanmetrics `calls_total` that drives `tracesToMetrics`.

const DASHBOARD_UID = "edge-auth";

export function edgeAuthDashboardJson(): string {
  let dashboard = new DashboardBuilder("Edge + Auth RED")
    .uid(DASHBOARD_UID)
    .description(
      "RED (request rate, error %, latency) for the gateway and auth services, by op. Hand-rolled Effect.Metric series — not span-derived (ADR-0010).",
    )
    .tags(["services", "red"])
    .refresh("30s");

  for (const panel of redRow("gateway", { y: 0 })) {
    dashboard = dashboard.withPanel(panel);
  }
  for (const panel of redRow("auth", { y: 9 })) {
    dashboard = dashboard.withPanel(panel);
  }

  return JSON.stringify(dashboard.build(), null, 2);
}
