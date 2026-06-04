import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";

import { deployAnnotationLayer } from "./_deploy-annotation-layer.ts";
import { exemplarLatencyPanel } from "./_exemplar.ts";
import { scenarioAnnotationLayer } from "./_scenario-annotation-layer.ts";
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
    .refresh("30s")
    .annotation(deployAnnotationLayer())
    .annotation(scenarioAnnotationLayer());

  for (const panel of redRow("gateway", { y: 0 })) {
    dashboard = dashboard.withPanel(panel);
  }
  for (const panel of redRow("auth", { y: 9 })) {
    dashboard = dashboard.withPanel(panel);
  }

  // Drill-to-trace latency beside the hand-rolled RED: span-derived series carry exemplars,
  // so a latency spike here jumps to the slow trace in Tempo (ADR-0011 Tier 2). One per service.
  // y:18 sits directly below the two 9-high RED rows (gateway 0-9, auth 9-18).
  dashboard = dashboard
    .withPanel(
      exemplarLatencyPanel("Gateway latency → trace", "gateway", { h: 8, w: 12, x: 0, y: 18 }),
    )
    .withPanel(exemplarLatencyPanel("Auth latency → trace", "auth", { h: 8, w: 12, x: 12, y: 18 }));

  return JSON.stringify(dashboard.build(), null, 2);
}
