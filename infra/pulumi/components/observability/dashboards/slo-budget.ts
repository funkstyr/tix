import { DashboardBuilder } from "@grafana/grafana-foundation-sdk/dashboard";

import { deployAnnotationLayer } from "./_deploy-annotation-layer.ts";
import { statPanel, tsPanel } from "./_shared.ts";

// SLO error-budget burndown (ADR-0011 Tier 3; widened ADR-0012 Tier 1), Platform folder. Reads the
// `slo:error_budget_consumed:ratio` recording rule (prometheus-backend.ts) — current 1h bad-event
// ratio over each SLO's budget, so 1.0 (100%) means burning exactly at the budget rate and >1 means
// burning faster than the SLO allows. The recorded series carries a `service` label, so a single
// target legends by SLO rather than one target per objective — and now that every SLO (gateway/auth
// availability, the checkout/payment coverage SLOs, and the latency objectives) records under that
// one rule, this board covers all of them with no per-SLO target.

const DASHBOARD_UID = "slo-budget";

const CONSUMED = "slo:error_budget_consumed:ratio";

export function sloBudgetDashboardJson(): string {
  let dashboard = new DashboardBuilder("SLO Error Budget")
    .uid(DASHBOARD_UID)
    .description(
      "Error-budget burndown: current error ratio over each service's budget (ADR-0011 Tier 3).",
    )
    .tags(["platform", "slo"])
    .refresh("30s")
    .annotation(deployAnnotationLayer());

  for (const panel of [
    statPanel("Error budget consumed (1h)", "percentunit", { h: 8, w: 12, x: 0, y: 0 }, [
      { expr: CONSUMED, legend: "{{service}}" },
    ]),
    tsPanel("Error budget consumed — trend", "percentunit", { h: 8, w: 12, x: 12, y: 0 }, [
      { expr: CONSUMED, legend: "{{service}}" },
    ]),
  ]) {
    dashboard = dashboard.withPanel(panel);
  }

  return JSON.stringify(dashboard.build(), null, 2);
}
